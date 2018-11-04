'use strict'

const { app, Notification, shell, dialog } = require('electron')
const { exec, execSync, spawn } = require('child_process')
const chokidar = require('chokidar')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const settings = require('./settings')

// Adds Resources/bin/<platform> PATH variable to system PATH
let localBinPath = path.join(process.resourcesPath, 'bin', process.platform)
if (process.platform === 'linux' || process.platform === 'darwin') {
  process.env.PATH = process.env.PATH + ':' + path.join('/', 'usr', 'local', 'bin')
  process.env.PATH = process.env.PATH + ':' + localBinPath
} else if (process.platform === 'win32') {
  process.env.Path = process.env.Path + ';' + localBinPath
}

/**
 * BookmarkProcessManager registry
 */
const processRegistry = {}

/**
 * Rclone settings cache
 * @private
 */
const _Cache = {
  version: null,
  configFile: '',
  binaryPath: '',
  providers: {},
  bookmarks: {},
  registeredUpdateCallbacks: []
}

/**
 * Simple process tracker. Used to track the rclone command processes status and output.
 */
class BookmarkProcessManager {
  constructor (processName, bookmarkName) {
    this.id = crypto.createHash('md5').update(bookmarkName + '/' + processName).digest('hex')
    this.bookmarkName = bookmarkName
    this.processName = processName
    this.isOk = false
  }

  create (process, bookmark) {
    let id = this.id
    processRegistry[id] = {
      bookmarkName: this.bookmarkName,
      processName: this.processName,
      process: process
    }
    let self = this

    process.stderr.on('data', rcloneProcessWatchdog.bind(this, bookmark))

    process.on('close', function () {
      if (self.isOk) {
        if (self.processName === 'download') {
          (new Notification({ body: `Download on ${self.bookmarkName} process finished` })).show()
        } else if (self.processName === 'upload') {
          (new Notification({ body: `Upload process on ${self.bookmarkName} finished` })).show()
        } else if (self.processName === 'mount') {
          (new Notification({ body: `Unmounted ${self.bookmarkName}` })).show()
        } else if (self.processName.match(/^serve:/)) {
          let protocol = self.processName.match(/^serve:(.*)/)
          let servingProtocolName = this.getServingProtocols()[protocol]
          ;(new Notification({ body: `Stopped serving ${self.bookmarkName} via ${servingProtocolName}` })).show()
        }
      }
      delete processRegistry[id]
      require('./tray').refresh()
    })
  }

  exists () {
    return processRegistry.hasOwnProperty(this.id)
  }

  get () {
    if (this.exists()) {
      return processRegistry[this.id].process
    } else {
      throw Error('No such process')
    }
  }

  kill (signal) {
    if (this.exists()) {
      processRegistry[this.id].process.kill(signal || 'SIGTERM')
    } else {
      throw Error('No such process')
    }
  }

  static killAll (bookmarkName, signal) {
    Object.values(processRegistry).forEach(function (item) {
      if (item.bookmarkName === bookmarkName) {
        item.process.kill(signal || 'SIGTERM')
      }
    })
  }

  static getActiveProcessesCount () {
    return Object.values(processRegistry).length
  }
}

/**
 * Process rclone output line and do action
 * @param {*} logLine
 */
const rcloneProcessWatchdogLine = function (logLine, bookmark, bookmarkProcess) {
  // Prepare lineInfo{time,level,message}
  let lineInfo = {}

  // Time is Y/m/d H:i:s
  lineInfo.time = logLine.substr(0, 19)

  // Level could be ERROR, NOTICE, INFO or DEBUG.
  logLine = logLine.substr(19).trim().split(':')
  lineInfo.level = (logLine.shift() || '').toString().toUpperCase().trim()

  // String message
  lineInfo.message = logLine.join(':').trim()

  if (lineInfo.level === 'FATAL ERROR') {
    (new Notification({ body: lineInfo.message })).show()
    bookmarkProcess.get().kill()
    require('./tray').refresh()
    return
  }

  if (lineInfo.message.match(/(Error while Logging.*)/)) {
    (new Notification({ body: lineInfo.message })).show()
    bookmarkProcess.get().kill()
    require('./tray').refresh()
    return
  }

  if (lineInfo.message.match(/(Error while Dialing|Failed to)/i)) {
    (new Notification({ body: lineInfo.message })).show()
    bookmarkProcess.get().kill()
    require('./tray').refresh()
    return
  }

  if (lineInfo.message.match('Mounting on "')) {
    (new Notification({ body: `Mounted ${bookmark.$name}` })).show()
    require('./tray').refresh()
    bookmarkProcess.isOk = true
    return
  }

  if (lineInfo.message.match('finishing with parameters')) {
    require('./tray').refresh()
  }

  let addressInUse = lineInfo.message.match(/Opening listener.*address already in use/)
  if (addressInUse) {
    (new Notification({ body: addressInUse[0] })).show()
    bookmarkProcess.get().kill()
    require('./tray').refresh()
    return
  }

  let matchingString = lineInfo.message.match(/(Serving on|Server started on|Server listening on|Serving restic REST API on)\s*(.*)$/)
  if (matchingString && matchingString[2]) {
    (new Notification({ body: matchingString[0] })).show()
    bookmarkProcess.URI = matchingString[2]
    bookmarkProcess.isOk = true
    require('./tray').refresh()
    return
  }

  console.log('Unhandled.', lineInfo)
}

/**
 * Helper function that split stream to lines and send to rcloneProcessWatchdogLine for processing
 * @param {*} bookmark
 * @param {*} data
 */
const rcloneProcessWatchdog = function (bookmark, data) {
  // https://stackoverflow.com/a/30136877
  let acc = ''
  let splitted = data.toString().split(/\r?\n/)
  let inTactLines = splitted.slice(0, splitted.length - 1)
  inTactLines[0] = acc + inTactLines[0] // if there was a partial, unended line in the previous dump, it is completed by the first section.
  acc = splitted[splitted.length - 1] // if there is a partial, unended line in this dump, store it to be completed by the next (we assume there will be a terminating newline at some point. This is, generally, a safe assumption.)
  for (var i = 0; i < inTactLines.length; ++i) {
    rcloneProcessWatchdogLine(inTactLines[i].trim(), bookmark, this)
  }
}

/**
 * Update the Rclone binary command file path.
 */
const updateRcloneBinaryPathCache = function () {
  let directory = settings.get('rclone_binary_directory')
  let binaryFileName = process.platform === 'win32' ? 'rclone.exe' : 'rclone'

  if (directory) {
    _Cache.binaryPath = path.join(directory, binaryFileName)
  } else {
    _Cache.binaryPath = binaryFileName
  }
}

/**
 * Get current config file location
 * @returns {string|*}
 */
const getConfigFile = function () {
  return _Cache.configFile
}

/**
 * Prepare array to Rclone command, rclone binary should be ommited
 * @param rcloneCommand
 * @returns {string}
 * @private
 */
const prepareRcloneCommand = function (rcloneCommand, pargs) {
  if (typeof rcloneCommand === 'string') {
    rcloneCommand = [ rcloneCommand ]
  }

  if (!Array.isArray(rcloneCommand)) {
    throw Error('Broken Command')
  }

  // @TODO escape command args.

  let command = [
    _Cache.binaryPath
  ]

  let config = getConfigFile()
  if (config) {
    command.push('--config', config)
  }

  command = command.concat(rcloneCommand)

  if (pargs === true) {
    command = [
      command.shift(),
      command
    ]
  } else {
    // Qoting all parameters
    for (let i in command) {
      if (command[i].substr(0, 2) !== '--') {
        command[i] = JSON.stringify(command[i])
      }
    }
    command = command.join(' ')
  }
  return command
}

/**
 * Execute synchronious Rclone command and return the output
 * @param command
 * @returns {*}
 * @private
 * @throws {err}
 */
const doSyncCommand = function (command) {
  try {
    command = prepareRcloneCommand(command)
    console.info('Rclone[A]', command)
    let output = execSync(command).toString()
    // Log.add('rclone', '-> ' + command)
    // Log.add('rclone', '<- ' + output)
    return output
  } catch (err) {
    // Log.add('rclone', 'ERROR: ' + JSON.stringify(err))
    console.error('Rclone', err)
    throw Error('Rclone command error')
  }
}

/**
 * Execute async Rclone command
 * @param command
 * @returns {Promise}
 * @private
 */
const doCommand = function (command) {
  return new Promise(function (resolve, reject) {
    command = prepareRcloneCommand(command)
    console.info('Rclone[S]', command)
    exec(command, function (err, stdout, stderr) {
      if (err) {
        console.error('Rclone', err)
        reject(Error('Rclone command error.'))
      } else {
        resolve(stdout)
      }
    })
  })
}

/**
 * Update version cache
 */
const updateVersionCache = function () {
  doCommand(['version'])
    .then(function (output) {
      let version = output.trim().split(/\r?\n/).shift().split(' ').pop() || 'Unknown'
      if (_Cache.version && _Cache.version !== version) {
        // rclone binary is upgraded
      }
      _Cache.version = version
    })
    .catch(function (err) {
      console.error(err)
      throw Error('Rclone is not installed or cannot be found on your system')
    })
}

/**
 * Update bookmarks cache
 * @private
 */
const updateBookmarksCache = function () {
  doCommand([ 'config', 'dump' ])
    .then(function (bookmarks) {
      try {
        bookmarks = JSON.parse(bookmarks)

        // Add virtual $name representing the bookmark name from index.
        Object.keys(bookmarks).map(function (key) {
          bookmarks[key].$name = key
        })
      } catch (err) {
        throw Error('Problem reading bookmarks list.')
      }
      _Cache.bookmarks = bookmarks
      fireRcloneUpdateActions()
    })
}

/**
 * Update providers cache, add $type options objects
 * @private
 */
const updateProvidersCache = function () {
  doCommand([ 'config', 'providers' ])
    .then(function (providers) {
      try {
        providers = JSON.parse(providers)
      } catch (err) {
        throw Error('Cannot read providers list.')
      }

      _Cache.providers = {}
      providers.forEach(function (provider) {
        provider.Options.map(function (optionDefinition) {
          optionDefinition.$type = 'string'
          if (optionDefinition.Default === true || optionDefinition.Default === false) {
            optionDefinition.$type = 'bool'
          } else if (!isNaN(parseFloat(optionDefinition.Default)) && isFinite(optionDefinition.Default)) {
            optionDefinition.$type = 'number'
          } else if (optionDefinition.IsPassword) {
            optionDefinition.$type = 'password'
          } else {
            optionDefinition.$type = 'string'
          }
          return optionDefinition
        })
        _Cache.providers[provider.Name] = provider
      })

      fireRcloneUpdateActions()
    })
}

/**
 *
 * @param {*} bookmarkName
 * @param {*} providerObject
 * @param {*} values
 */
const updateBookmarkFields = function (bookmarkName, providerObject, values) {
  const reserved = [
    {
      'Name': '_local_path_map',
      'Required': false
    }
  ]

  reserved.concat(providerObject.Options).forEach(function (optionDefinition) {
    console.log(['config', 'password', bookmarkName, optionDefinition.Name, values[optionDefinition.Name]])
    if (optionDefinition.$type === 'password') {
      if (optionDefinition.Name in values) {
        doSyncCommand(['config', 'password', bookmarkName, optionDefinition.Name, values[optionDefinition.Name]])
      }
    } else {
      // Sanitize booleans.
      if (optionDefinition.$type === 'bool') {
        if (optionDefinition.Name in values && [ 'true', 'yes', true, 1 ].indexOf(values[optionDefinition.Name]) > -1) {
          values[optionDefinition.Name] = 'true'
        } else {
          values[optionDefinition.Name] = 'false'
        }
      }

      doSyncCommand(['config', 'update', bookmarkName, optionDefinition.Name, values[optionDefinition.Name]])
    }
  })
  console.log('Rclone', 'Updated bookmark ' + bookmarkName)
}

/**
 * Trigger for register update cache listeners
 * @param eventName
 * @private
 */
const fireRcloneUpdateActions = function (eventName) {
  for (let i in _Cache.registeredUpdateCallbacks) {
    _Cache.registeredUpdateCallbacks[i](eventName)
  }
}

/**
 *
 * @private
 */
const resetRcloneCache = function () {
  console.info('Resetting Rclone cache')
  updateProvidersCache()
  updateBookmarksCache()
  // updateVersionCache()
}

/**
 *
 * @param {*} bookmarkName
 * @param {*} pathName
 */
let _sync = function (method, bookmark) {
  if (method !== 'upload' && method !== 'download') {
    throw Error(`Unsupported sync way ${method}`)
  }

  let methodLabel = ''

  let cmd = [ 'sync' ]
  if (method === 'upload') {
    methodLabel = 'Upload'
    cmd.push(bookmark._local_path_map, bookmark.$name + ':')
  } else {
    methodLabel = 'Download'
    cmd.push(bookmark._local_path_map, bookmark.$name + ':')
  }
  cmd.push('-vv')
  cmd = prepareRcloneCommand(cmd, true)

  if ('_local_path_map' in bookmark && bookmark._local_path_map) {
    // Check if source directory is empty because this could damage remote one.
    if (method === 'upload') {
      if (!fs.readdirSync(bookmark._local_path_map).length) {
        throw Error('Cannot upload empty directory.')
      }
    }

    let proc = new BookmarkProcessManager(method === 'download' ? 'upload' : 'download', bookmark.$name)

    if (proc.exists()) {
      throw Error(`Bookmark ${bookmark.$name} is in ${methodLabel} process.`)
    }

    if ((new BookmarkProcessManager('upload', bookmark.$name)).exists()) {
      throw Error(`Cannot perform downloading and uploading in same time.`)
    }

    proc.create(spawn(cmd[0], cmd[1]), bookmark)
    require('./tray').refresh()
  } else {
    console.error('SYNC', 'Local Path Map is not set for this bookmark', bookmark)
    throw Error('Local Path Map is not set for this bookmark')
  }
}

const exposedApi = {

  init: resetRcloneCache,

  /**
   * Add callback to execute when Rclone config is changed.
   * @param callback
   */
  onUpdate: function (callback) {
    _Cache.registeredUpdateCallbacks.push(callback)
  },

  /**
   * Get current config file
   *
   * @param {string}
   */
  getConfigFile: getConfigFile,

  /**
   * Get available providers
   *
   * @returns {_Cache.providers|{}}
   */
  getProviders: function () {
    return _Cache.providers
  },

  /**
   * Get specific provider
   *
   * @param providerName
   *
   * @returns {*}
   */
  getProvider: function (providerName) {
    if (_Cache.providers.hasOwnProperty(providerName)) {
      return _Cache.providers[providerName]
    } else {
      throw Error(`No such provider ${providerName}`)
    }
  },

  /**
   * Get bookmarks
   *
   * @returns {_Cache.bookmarks|{}|*}
   */
  getBookmarks: function () {
    return _Cache.bookmarks
  },

  /**
   * Get bookmark
   *
   * @param bookmarkName
   *
   * @returns {*}
   */
  getBookmark: function (bookmark) {
    if (typeof bookmark === 'object') {
      if ('$name' in bookmark && 'type' in bookmark) {
        return bookmark
      } else {
        throw Error(`Invalid bookmark object argument.`)
      }
    } else if (bookmark in _Cache.bookmarks) {
      return _Cache.bookmarks[bookmark]
    } else {
      throw Error(`No such bookmark ${bookmark}`)
    }
  },

  /**
   * Create new bookmark
   *
   * @param type
   * @param bookmarkName
   * @param options
   *
   * @returns {Promise}
   */
  addBookmark: function (type, bookmarkName, values) {
    // Will throw an error if no such provider exists.
    let providerObject = this.getProvider(type)
    let configFile = this.getConfigFile()

    return new Promise(function (resolve, reject) {
      if (!bookmarkName.match(/^([a-zA-Z0-9\-_]{1,32})$/)) {
        reject(Error(`Invalid name.\nName should be 1-32 chars long, and should contain only letters, gidits - and _`))
        return
      }

      if (_Cache.bookmarks.hasOwnProperty(bookmarkName)) {
        reject(Error(`There "${bookmarkName}" bookmark already`))
        return
      }
      try {
        let iniBlock = `\n[${bookmarkName}]\nconfig_automatic = no\ntype = ${type}\n`
        fs.appendFileSync(configFile, iniBlock)
        console.log('Rclone', 'Writing new block to config file')
        try {
          updateBookmarkFields(bookmarkName, providerObject, values)
        } catch (err) {
          console.log('Rclone', 'Reverting')
          doCommand(['config', 'delete', bookmarkName])
            .then(function () {
              reject(Error('Cannot write bookmark options to config.'))
              ;(new Notification({ body: `Bookmark ${bookmarkName} is created` })).show()
              resolve()
            })
            .catch(reject)
        }
      } catch (err) {
        console.error(err)
        reject(Error('Cannot create new bookmark'))
      }
    })
  },

  /**
   * Update existing bookmark
   *
   * @param bookmarkName
   * @param options
   *
   * @returns {Promise}
   */
  updateBookmark: function (bookmark, values) {
    bookmark = this.getBookmark(bookmark)
    let providerObject = this.getProvider(bookmark.type)
    return new Promise(function (resolve, reject) {
      try {
        updateBookmarkFields(bookmark.$name, providerObject, values);
        (new Notification({ body: `Bookmark ${bookmark.Name} is updated.` })).show()
        resolve()
      } catch (err) {
        reject(err)
      }
    })
  },

  /**
   * Delete existing bookmark
   *
   * @param bookmarkName
   *
   * @returns {Promise}
   */
  deleteBookmark: function (bookmark) {
    bookmark = this.getBookmark(bookmark)
    return new Promise(function (resolve, reject) {
      doCommand([ 'config', 'delete', bookmark.$name ])
        .then(function () {
          BookmarkProcessManager.killAll(bookmark.$name)
          ;(new Notification({ body: `Bookmark ${bookmark.$name} is deleted.` })).show()
          resolve()
        })
        .catch(reject)
    })
  },

  /**
   * Get (generate) path to bookmark mountpoint
   *
   * @param {*} bookmark
   *
   * @returns {String}
   */
  getMountpointVolumePath: function (bookmark) {
    bookmark = this.getBookmark(bookmark)
    return path.join('/', 'Volumes', bookmark.type + '.' + bookmark.$name)
  },

  /**
   * Mount given bookmark
   *
   * @param {*} bookmark
   */
  mount: function (bookmark) {
    bookmark = this.getBookmark(bookmark)
    let proc = new BookmarkProcessManager('mount', bookmark.$name)

    if (proc.exists()) {
      throw Error(`Bookmark ${bookmark.$name} already mounted.`)
    }
    let mountpoint = this.getMountpointVolumePath(bookmark)
    let cmd = prepareRcloneCommand([
      'mount',
      bookmark.$name + ':',
      mountpoint,
      '--attr-timeout', '3s',
      '--dir-cache-time', '3s',
      '--allow-non-empty',
      '--volname', bookmark.$name,
      '-vv'
    ], true)

    proc.create(spawn(cmd[0], cmd[1]), bookmark)
    require('./tray').refresh()
  },

  /**
   * Unmount given bookmark (if it's mounted)
   *
   * @param {*} bookmark
   */
  unmount: function (bookmark) {
    bookmark = this.getBookmark(bookmark)
    let mountStatus = this.mountStatus(bookmark)
    if (mountStatus !== false) {
      let proc = new BookmarkProcessManager('mount', bookmark.$name)
      if (proc.exists()) {
        proc.kill()
      }
      if (mountStatus) {
        exec(`umount -f "${mountStatus}"`)
      }
    }
  },

  /**
   * Check is given bookmark is mounted
   *
   * @param {boolean} bookmark
   *
   * @returns {false|string Mountpoint}
   */
  mountStatus: function (bookmark) {
    bookmark = this.getBookmark(bookmark)
    let proc = new BookmarkProcessManager('mount', bookmark.$name)
    let exists = proc.exists()
    let mountpoint = this.getMountpointVolumePath(bookmark)
    let mountpointExists = fs.existsSync(mountpoint)
    if (exists && mountpointExists) {
      return mountpoint
    } else if (exists || mountpointExists) {
      return ''
    } else {
      return false
    }
  },

  /**
   * Open mounted directory bookmark in platform's file browser
   *
   * @param {*} bookmark
   */
  openMounted: function (bookmark) {
    bookmark = this.getBookmark(bookmark)
    if (this.mountStatus(bookmark) !== false) {
      return shell.openExternal('file://' + this.getMountpointVolumePath(bookmark))
    } else {
      return false
    }
  },

  /**
   *
   * @param {*} bookmarkName
   */
  download: function (bookmark) {
    _sync('download', this.getBookmark(bookmark))
  },

  /**
   *
   * @param {*} bookmarkName
   */
  upload: function (bookmark) {
    _sync('upload', this.getBookmark(bookmark))
  },

  /**
   * Check if current is uploading
   *
   * @param {*} protocol
   * @param {*} bookmark
   *
   * @returns {boolean}
   */
  isUploading: function (bookmark) {
    bookmark = this.getBookmark(bookmark)
    return (new BookmarkProcessManager('upload', bookmark.$name)).exists()
  },

  /**
   * Check if current is downloading
   *
   * @param {*} protocol
   * @param {*} bookmark
   *
   * @returns {boolean}
   */
  isDownloading: function (bookmark) {
    bookmark = this.getBookmark(bookmark)
    return (new BookmarkProcessManager('download', bookmark.$name)).exists()
  },

  /**
   *
   * @param {*} bookmark
   */
  stopDownloading (bookmark) {
    bookmark = this.getBookmark(bookmark)
    ;(new BookmarkProcessManager('download', bookmark.$name)).kill()
  },

  /**
   *
   * @param {*} bookmark
   */
  stopUploading (bookmark) {
    bookmark = this.getBookmark(bookmark)
    ;(new BookmarkProcessManager('upload', bookmark.$name)).kill()
  },

  /**
   * Open local path mapping
   *
   * @param {*} bookmark
   */
  openLocal: function (bookmark) {
    bookmark = this.getBookmark(bookmark)
    if ('_local_path_map' in bookmark) {
      if (fs.existsSync(bookmark._local_path_map)) {
        return shell.openExternal('file://' + bookmark._local_path_map)
      } else {
        console.error('Rclone', 'Local path does not exists.', bookmark._local_path_map, bookmark.$name)
        throw Error(`Local path ${bookmark._local_path_map} does not exists`)
      }
    } else {
      return false
    }
  },

  /**
   * Get available serving protocols
   *
   * @returns {Object}
   */
  getServingProtocols: function () {
    return {
      http: 'HTTP',
      ftp: 'FTP',
      webdav: 'WebDAV',
      restic: 'Restic'
    }
  },

  /**
   * Start serving protocol+bookmark
   *
   * @param {*} method
   * @param {*} bookmarkName
   * @param {*} pathName
   */
  serveStart: function (protocol, bookmark) {
    if (!this.getServingProtocols().hasOwnProperty(protocol)) {
      throw Error(`Protocol "${protocol}" is not supported`)
    }

    bookmark = this.getBookmark(bookmark)

    let proc = new BookmarkProcessManager('serve:' + protocol, bookmark.$name)

    if (proc.exists()) {
      throw Error(`${bookmark.$name} is already serving.`)
    }

    let cmd = prepareRcloneCommand([
      'serve',
      protocol,
      bookmark.$name + ':',
      '-vv'
    ], true)

    proc.create(spawn(cmd[0], cmd[1]), bookmark)
    require('./tray').refresh()
  },

  /**
   * Stop serving protocol+bookmark
   *
   * @param {*} protocol
   * @param {*} bookmark
   */
  serveStop: function (protocol, bookmark) {
    bookmark = this.getBookmark(bookmark)
    if (this.serveStatus(protocol, bookmark) !== false) {
      let proc = new BookmarkProcessManager('serve:' + protocol, bookmark.$name)
      if (proc.exists()) {
        proc.kill()
      }
    }
  },

  /**
   * Check if current protocol+bookmark is in serving
   *
   * @param {*} protocol
   * @param {*} bookmark
   *
   * @returns {boolean}
   */
  serveStatus (protocol, bookmark) {
    bookmark = this.getBookmark(bookmark)
    let proc = new BookmarkProcessManager('serve:' + protocol, bookmark.$name)
    if (proc.exists()) {
      return proc.URI || ''
    } else {
      return false
    }
  },

  /**
   * Open NCDU in platform's terminal emulator
   *
   * @param {*} bookmarkName
   */
  ncdu: function (bookmark) {
    bookmark = this.getBookmark(bookmark)

    let cmd = prepareRcloneCommand(['ncdu', bookmark.$name + ':/'])

    if (process.platform === 'darwin') {
      cmd = cmd.replace(new RegExp('"', 'g'), '\\"')
      spawn('/usr/bin/osascript', ['-e', `tell application "Terminal" to do script "${cmd}" activate`])
    } else if (process.platform === 'linux') {
      let tempCmdWrapper = path.join(app.getPath('temp'), 'linux-cmd-wrapper.sh')
      const data = new Uint8Array(Buffer.from(cmd))
      fs.writeFile(tempCmdWrapper, data, function (err) {
        if (err) {
          throw Error('Cannot open terminal')
        } else {
          fs.chmodSync(tempCmdWrapper, 0o755)
          exec(`x-terminal-emulator -e "${tempCmdWrapper}"`)
        }
      })
    } else if (process.platform === 'win32') {
      exec(`start cmd.exe /K "${cmd}"`)
    } else {
      throw Error('(NCDU) Unsupported platform ' + process.platform)
    }
  },

  /**
   * Get Rclone version
   *
   * @returns {string}
   */
  getVersion: function () {
    return _Cache.version
  }

}

// Update binary file path cache.
updateRcloneBinaryPathCache()

// Try set the version cache, if fail, then seems we have no rclone installed.
updateVersionCache()

// Update config file path cache.
if (settings.get('rclone_config', '')) {
  _Cache.configFile = settings.get('rclone_config', '')
} else {
  let output = doSyncCommand(['config', 'file'])
  _Cache.configFile = output.trim().split(/\r?\n/).pop()
}

// While chokidar fails if the watching file is not exists.
// then need to create empty rclone conf file.
if (!fs.existsSync(getConfigFile())) {
  fs.appendFileSync(getConfigFile(), '')
}

// chokidar seems to be more relyable than fs.watch() and give better results.
chokidar.watch(getConfigFile(), {
  ignoreInitial: true,
  disableGlobbing: true,
  usePolling: false,
  useFsEvents: true,
  persistent: true,
  alwaysStat: true,
  atomic: true
})
  .on('change', resetRcloneCache)

// Force killing all processes if the app is going to quit.
app.on('before-quit', function (event) {
  if (Object.keys(processRegistry).length > 0) {
    let choice = dialog.showMessageBox(null, {
      type: 'warning',
      buttons: ['Yes', 'No'],
      title: 'Quit RcloneTray',
      message: 'Are you sure you want to quit? There is active processes that will be terminated.'
    })

    if (choice !== 0) {
      event.preventDefault()
      return
    }
  }

  Object.keys(processRegistry).map(function (key) {
    processRegistry[key].process.kill()
  })
})

// Expose rclone api.
module.exports = exposedApi