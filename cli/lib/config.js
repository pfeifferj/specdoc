'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { usage } = require('./errors')
function configDir (env = process.env) {
  return path.resolve(env.SPECDOC_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config'), 'specdoc'))
}
function readConfig (env = process.env) {
  const file = path.join(configDir(env), 'config.json')
  let config
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, defaultProfile: 'default', profiles: {} }
    throw usage(`Cannot read configuration: ${e.message}`)
  }
  if (config.version !== 1 || !config.profiles || typeof config.profiles !== 'object' || Array.isArray(config.profiles)) throw usage('Unsupported configuration format')
  return config
}
function writeConfig (config, env = process.env) {
  const dir = configDir(env)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'config.json')
  const temp = `${file}.${process.pid}.${require('node:crypto').randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, file)
  } finally { try { fs.unlinkSync(temp) } catch (e) { if (e.code !== 'ENOENT') throw e } }
}
function origin (value) {
  if (!value) return undefined
  let url
  try { url = new URL(value) } catch { throw usage(`Invalid origin: ${value}`) }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['https:', 'http:'].includes(url.protocol)) throw usage('Origins must be HTTP(S) URLs without credentials, paths, queries or fragments')
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw usage('Use HTTPS except for loopback development origins')
  return url.origin
}
function resolveConfig (options = {}, env = process.env) {
  const saved = readConfig(env)
  const profile = options.profile || env.SPECDOC_PROFILE || saved.defaultProfile || 'default'
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(profile)) throw usage('Invalid profile name')
  const profileData = saved.profiles[profile] || {}
  return {
    profile, profileData, configDir: configDir(env), env,
    boardOrigin: origin(options.boardUrl || env.SPECDOC_BOARD_URL || env.SPECDOC_URL || profileData.boardOrigin),
    editorOrigin: origin(options.editorUrl || env.SPECDOC_EDITOR_URL || profileData.editorOrigin)
  }
}
module.exports = { configDir, readConfig, writeConfig, resolveConfig, origin }
