'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function failure (code, message) {
  return Object.assign(new Error(message), { code })
}

function originFor (config, identity) {
  const origin = identity === 'bot' ? config.boardOrigin : config.editorOrigin
  if (!origin) throw failure('CONFIG_REQUIRED', `Configure the ${identity === 'bot' ? 'board' : 'editor'} URL first.`)
  return origin.replace(/\/$/, '')
}

function credentialId (config, identity) {
  return crypto.createHash('sha256').update(JSON.stringify([config.profile, identity, originFor(config, identity)])).digest('hex')
}

function privateDirectory (directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const st = fs.lstatSync(directory)
  if (!st.isDirectory() || st.isSymbolicLink() ||
      (process.platform !== 'win32' && ((st.mode & 0o077) || st.uid !== process.getuid()))) {
    throw failure('CREDENTIAL_PERMISSIONS', 'Credential directory must be owned by you with permissions 0700.')
  }
}

function credentialPath (config, identity) {
  return path.join(config.configDir, 'credentials', `${credentialId(config, identity)}.json`)
}

function storageFor (config, identity, storage) {
  const selected = storage || config.profileData?.credentials?.[identity]?.storage || config.profileData?.storage || 'keyring'
  if (!['keyring', 'file'].includes(selected)) throw failure('USAGE', 'Credential storage must be keyring or file.')
  return selected
}

function entry (config, account) {
  try {
    const Factory = config.keyringFactory || require('@napi-rs/keyring').AsyncEntry
    return new Factory('specdoc', account, { linux: { store: 'secret-service' } })
  } catch {
    throw failure('KEYRING_UNAVAILABLE', 'The OS keyring is unavailable. Install optional dependencies and unlock the keyring, or explicitly use --storage file.')
  }
}

async function keyringCall (config, account, operation, value) {
  try {
    const target = entry(config, account)
    return value === undefined
      ? await target[operation](AbortSignal.timeout(10000))
      : await target[operation](value, AbortSignal.timeout(10000))
  } catch (error) {
    if (error.code === 'KEYRING_UNAVAILABLE') throw error
    throw failure('KEYRING_UNAVAILABLE', 'The OS keyring could not complete the request. Unlock it or explicitly use --storage file.')
  }
}

async function preflightStorage (config, identity = 'author', storage) {
  const selected = storageFor(config, identity, storage)
  const probe = crypto.randomUUID()
  if (selected === 'file') {
    const directory = path.dirname(credentialPath(config, identity))
    privateDirectory(config.configDir)
    privateDirectory(directory)
    const file = path.join(directory, `.probe-${probe}`)
    const fd = fs.openSync(file, 'wx', 0o600)
    fs.closeSync(fd)
    fs.unlinkSync(file)
  } else {
    const account = `${credentialId(config, identity)}:probe:${probe}`
    try {
      await keyringCall(config, account, 'setPassword', probe)
      if (await keyringCall(config, account, 'getPassword') !== probe) {
        throw failure('KEYRING_UNAVAILABLE', 'The OS keyring did not retain the test credential.')
      }
    } finally {
      await keyringCall(config, account, 'deleteCredential')
    }
  }
  return selected
}

function readPrivateFile (file) {
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const st = fs.fstatSync(fd)
    if (!st.isFile() || (process.platform !== 'win32' && ((st.mode & 0o077) || st.uid !== process.getuid()))) {
      throw failure('CREDENTIAL_PERMISSIONS', 'Credential file must be owned by you with permissions 0600.')
    }
    return fs.readFileSync(fd, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    if (error.code === 'ELOOP') throw failure('CREDENTIAL_PERMISSIONS', 'Credential files must not be symbolic links.')
    throw error
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function writePrivateFile (file, text) {
  const directory = path.dirname(file)
  privateDirectory(directory)
  const temporary = path.join(directory, `.credential-${crypto.randomUUID()}`)
  let fd
  try {
    fd = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(fd, text, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temporary, file)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

function checkedSecret (secret) {
  if (typeof secret !== 'string' || !secret || secret.length > 8192 || /[\s\x00-\x1f\x7f]/.test(secret)) {
    throw failure('INVALID_CREDENTIAL', 'Credential must be a non-empty token without whitespace.')
  }
  return secret
}

async function loadStoredCredential (config, identity = 'author') {
  const saved = config.profileData?.credentials?.[identity]
  if (!saved || saved.origin !== originFor(config, identity)) return null
  const selected = storageFor(config, identity)
  const text = selected === 'file'
    ? readPrivateFile(credentialPath(config, identity))
    : await keyringCall(config, credentialId(config, identity) + (saved.slot ? `:${saved.slot}` : ''), 'getPassword')
  if (text === null) return null
  let record
  try { record = JSON.parse(text) } catch { throw failure('INVALID_CREDENTIAL', 'Stored credential is not valid JSON.') }
  if (record.version !== 1 || record.profile !== config.profile || record.identity !== identity ||
      record.origin !== originFor(config, identity)) {
    throw failure('CREDENTIAL_ORIGIN_MISMATCH', 'Stored credential does not belong to this profile and service.')
  }
  checkedSecret(record.secret)
  return record
}

async function resolveCredential (config, identity = 'author') {
  const injected = identity === 'bot' ? config.botToken : config.authorToken
  if (injected) return { secret: checkedSecret(injected), source: 'stdin' }
  const env = config.env || process.env
  const tokenName = identity === 'bot' ? 'SPECDOC_BOT_TOKEN' : 'SPECDOC_TOKEN'
  const originName = identity === 'bot' ? 'SPECDOC_BOARD_URL' : 'SPECDOC_EDITOR_URL'
  if (env[tokenName]) {
    if (!env[originName] || env[originName].replace(/\/$/, '') !== originFor(config, identity)) {
      throw failure('CREDENTIAL_ORIGIN_MISMATCH', `${tokenName} must be paired with the matching ${originName}.`)
    }
    return { secret: checkedSecret(env[tokenName]), source: 'environment' }
  }
  const record = await loadStoredCredential(config, identity)
  return record ? { ...record, source: 'stored', storage: storageFor(config, identity) } : null
}

async function loadCredential (config, identity = 'author') {
  return (await resolveCredential(config, identity))?.secret || null
}

async function saveCredential (config, identity, secret, metadata = {}, storage) {
  checkedSecret(secret)
  const selected = storageFor(config, identity, storage)
  const origin = originFor(config, identity)
  const record = { version: 1, profile: config.profile, identity, origin, secret, metadata }
  const slot = selected === 'keyring' ? crypto.randomUUID() : null
  if (selected === 'file') {
    privateDirectory(config.configDir)
    writePrivateFile(credentialPath(config, identity), JSON.stringify(record) + '\n')
  } else {
    const account = credentialId(config, identity) + ':' + slot
    try {
      await keyringCall(config, account, 'setPassword', JSON.stringify(record))
      if (await keyringCall(config, account, 'getPassword') !== JSON.stringify(record)) {
        throw failure('KEYRING_UNAVAILABLE', 'The OS keyring did not retain the credential.')
      }
    } catch (cause) {
      try { await keyringCall(config, account, 'deleteCredential') } catch {
        cause.details = { ...cause.details, stagedCredentialCleanup: 'unconfirmed' }
      }
      throw cause
    }
  }
  const descriptor = { storage: selected, origin, metadata, ...(slot && { slot }) }
  config.profileData = config.profileData || {}
  config.profileData.credentials = { ...config.profileData.credentials, [identity]: descriptor }
  return descriptor
}

async function removeCredential (config, identity = 'author', storage) {
  const selected = storageFor(config, identity, storage)
  if (selected === 'file') {
    try { fs.unlinkSync(credentialPath(config, identity)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  } else {
    const slot = config.profileData?.credentials?.[identity]?.slot
    await keyringCall(config, credentialId(config, identity) + (slot ? `:${slot}` : ''), 'deleteCredential')
  }
}

module.exports = {
  loadCredential, loadStoredCredential, resolveCredential, saveCredential, removeCredential,
  preflightStorage, storageFor, credentialPath, checkedSecret
}
