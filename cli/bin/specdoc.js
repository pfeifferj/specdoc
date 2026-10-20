#!/usr/bin/env node
'use strict'
require('../lib/main').main().then(code => { process.exitCode = code }).catch(() => { process.exitCode = 1 })
