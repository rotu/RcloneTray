
> The app is under development. It's possible to have breaking changes until first public version. Using the app is at your own risk.


# <img src="https://raw.githubusercontent.com/dimitrov-adrian/RcloneTray/master/src/ui/icons/source-icon-color.png" width="48px" align="center" alt="RcloneTray Icon" /> RcloneTray

[![Build Status](https://travis-ci.org/dimitrov-adrian/RcloneTray.svg?branch=master)](https://travis-ci.org/dimitrov-adrian/rclonetray)
[![JavaScript Standard Style](https://img.shields.io/badge/code%20style-standard-brightgreen.svg)](http://standardjs.com)
![Dependencies](https://david-dm.org/dimitrov-adrian/RcloneTray/status.svg)

RcloneTray is simple cross-platform GUI for [Rclone](https://rclone.org/) and is intended to provide a free altenative to [Mountain Duck](https://mountainduck.io/)


## Overview
![Screenshot](https://raw.githubusercontent.com/dimitrov-adrian/RcloneTray/master/screenshot.png)


## Requirements
Only 64bit binaries are provided in distributions.

Supported operation systems:
* Windows 7/8/10 (x64)
* macOS 10.10 and later

There is some general problems with linux supports, so until fix them, can't say it is supported.

To get mount function working, you need to install extra packages:
* Windows - http://www.secfs.net/winfsp/download/
* macOS - https://osxfuse.github.io/


## FAQ

**The application bundle comes with Rclone version XXX, but I want to use version YYY?**

No problem, you need just to uncheck the option "Use bundled Rclone" and then RcloneTray will
use the system installed Rclone


## Downloads
The project is still in development, you can check latest builds from [releases](https://github.com/dimitrov-adrian/RcloneTray/releases)


## Contributing
Any help is welcome, just file an issue or pull request.


## Building

You'll need [Node.js](https://nodejs.org) installed on your computer in order to build this app.

```bash
$ git clone https://github.com/dimitrov-adrian/RcloneTray
$ cd RcloneTray
$ npm install
$ npm start
```

For easier developing the app is started with more verbose output, inspector in the menu and node console.


## License
This project is licensed under the [MIT](https://github.com/dimitrov-adrian/RcloneTray/blob/master/LICENSE.txt) License
