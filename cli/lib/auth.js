'use strict'

const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const { readConfig, writeConfig } = require('./config')
const {
  loadStoredCredential, resolveCredential, saveCredential, removeCredential,
  preflightStorage, checkedSecret
} = require('./credentials')

const CLIENT = 'specdoc-cli'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const tokenFields = ['id', 'name', 'scopes', 'expiresAt', 'revokedAt', 'lastUsedAt', 'createdAt']

function error (code, message, details) {
  return Object.assign(new Error(message), { code, ...(details && { details }) })
}

function metadata (body) {
  if (!body || !body.user || !body.token || typeof body.user.id !== 'string' ||
      typeof body.token.id !== 'string' || !Array.isArray(body.token.scopes)) {
    throw error('INVALID_RESPONSE', 'The server did not return valid identity and token metadata.')
  }
  return {
    user: { id: body.user.id, name: typeof body.user.name === 'string' ? body.user.name : '' },
    token: Object.fromEntries(tokenFields.filter(key => body.token[key] !== undefined).map(key => [key, body.token[key]]))
  }
}

function serviceUrl (config, route) {
  if (!config.editorOrigin) throw error('CONFIG_REQUIRED', 'Set --editor-url or configure an editor profile before signing in.')
  const base = new URL(config.editorOrigin)
  if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)))) {
    throw error('INVALID_ORIGIN', 'The editor URL must use HTTPS, or HTTP on loopback for local development.')
  }
  return config.editorOrigin.replace(/\/$/, '') + route
}

function unsupported (context, route) {
  const feature = ['/.well-known/specdoc', '/oauth/device/code'].includes(route)
    ? 'CLI browser login'
    : `the CLI authentication endpoint ${route}`
  return error('UNSUPPORTED_FEATURE', `The editor at ${context.config.editorOrigin} does not support ${feature}. Deploy the updated SpecDoc editor, then retry.`)
}

async function request (context, route, { body, token, method, signal, timeout = 10000 } = {}) {
  const url = serviceUrl(context.config, route)
  const timeoutSignal = AbortSignal.timeout(timeout)
  let response
  try {
    response = await (context.fetch || fetch)(url, {
      method: method || (body ? 'POST' : 'GET'),
      redirect: 'error',
      headers: {
        accept: 'application/json',
        ...(body && { 'content-type': 'application/json' }),
        ...(token && { authorization: `Bearer ${token}` })
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    })
  } catch {
    if (signal?.aborted) throw error('INTERRUPTED', 'Login was interrupted.')
    throw error('AUTH_NETWORK', 'The authentication request could not be completed.')
  }
  const text = await response.text()
  if (Buffer.byteLength(text) > 65536) throw error('INVALID_RESPONSE', 'The authentication response exceeds the size limit.')
  let data
  try { data = JSON.parse(text) } catch {
    if (response.ok) throw Object.assign(error('INVALID_RESPONSE', `The editor returned a non-JSON response for ${route} (HTTP ${response.status}). Check the configured editor URL and reverse proxy.`), { status: response.status })
  }
  if (!response.ok) {
    if ([404, 405, 501].includes(response.status)) throw Object.assign(unsupported(context, route), { status: response.status })
    const oauthCode = typeof data?.error === 'string' && /^[a-z_]{1,60}$/.test(data.error) ? data.error : null
    const code = oauthCode || (response.status === 401 ? 'AUTH_INVALID' : 'AUTH_FAILED')
    const message = oauthCode
      ? `Authorization returned ${oauthCode}.`
      : response.status === 401
        ? 'The server rejected this credential; sign in again.'
        : `Authentication failed with HTTP ${response.status}.`
    throw Object.assign(error(code, message), { status: response.status })
  }
  return data
}

function persistProfile (context) {
  const config = context.config
  const document = readConfig(context.env)
  document.version = 1
  document.defaultProfile = document.defaultProfile || config.profile
  document.profiles = {
    ...document.profiles,
    [config.profile]: {
      ...document.profiles?.[config.profile],
      ...config.profileData,
      ...(config.boardOrigin && { boardOrigin: config.boardOrigin }),
      editorOrigin: config.editorOrigin
    }
  }
  writeConfig(document, context.env)
}

async function installCredential (context, secret, identity, storage, managed) {
  const config = context.config
  const beforeProfile = JSON.parse(JSON.stringify(config.profileData || {}))
  const old = await loadStoredCredential(config)
  const oldStorage = beforeProfile.credentials?.author?.storage
  let wrote = false
  try {
    await saveCredential(config, 'author', secret, { ...identity, managed }, storage)
    wrote = true
    persistProfile(context)
  } catch (cause) {
    if (wrote) {
      try {
        if (old && oldStorage === 'file' && storage === 'file') {
          await saveCredential(config, 'author', old.secret, old.metadata, oldStorage)
        } else {
          await removeCredential(config, 'author', storage)
        }
      } catch {
        cause.details = { ...cause.details, credentialRollback: 'unconfirmed' }
      }
    }
    config.profileData = beforeProfile
    throw cause
  }
  const warnings = []
  if (old && (oldStorage !== storage || oldStorage === 'keyring')) {
    try { await removeCredential({ ...config, profileData: beforeProfile }, 'author', oldStorage) } catch { warnings.push('Previous credential storage could not be cleared.') }
  }
  if (old && old.secret !== secret && old.metadata.managed) {
    try { await request(context, '/api/v1/auth/token', { method: 'DELETE', token: old.secret }) } catch { warnings.push('Previous managed token revocation is unconfirmed.') }
  }
  return { profile: config.profile, editorOrigin: config.editorOrigin, storage, state: 'authenticated', verified: true, ...identity, ...(warnings.length && { warnings }) }
}

async function readToken (stdin) {
  let text = ''
  for await (const chunk of stdin) {
    text += chunk.toString()
    if (text.length > 8192) throw error('INVALID_CREDENTIAL', 'Credential input exceeds the size limit.')
  }
  return checkedSecret(text.trim())
}

function openBrowser (url, context) {
  if (context.openBrowser) return context.openBrowser(url)
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false })
  child.on('error', () => context.stderr.write('Could not open the browser. Open the displayed link manually.\n'))
  child.on('exit', code => { if (code) context.stderr.write('Browser opening failed. Open the displayed link manually.\n') })
  child.unref()
}

function validateGrant (grant, config) {
  if (!grant || typeof grant.device_code !== 'string' || grant.device_code.length < 20 ||
      typeof grant.user_code !== 'string' || !/^[a-z0-9-]{4,32}$/i.test(grant.user_code) ||
      !Number.isInteger(grant.expires_in) || grant.expires_in <= 0 || grant.expires_in > 600 ||
      !Number.isInteger(grant.interval) || grant.interval < 1 || grant.interval > 60) {
    throw error('INVALID_RESPONSE', 'The server returned an invalid device authorization grant.')
  }
  const verification = new URL(grant.verification_uri_complete || grant.verification_uri)
  const editor = new URL(config.editorOrigin)
  if (verification.origin !== editor.origin || verification.username || verification.password || verification.hash ||
      [...verification.searchParams.values()].some(value => value.includes(grant.device_code))) {
    throw error('INVALID_RESPONSE', 'The verification link does not belong to the configured editor.')
  }
  return verification.href
}

async function login (options, context) {
  if (options.nonInteractive && !options.tokenStdin) {
    throw error('INTERACTION_REQUIRED', 'Browser authorization requires user interaction. Supply an existing token with --token-stdin for non-interactive login.')
  }
  serviceUrl(context.config, '/')
  if (options.expiresInDays !== undefined && (!Number.isInteger(Number(options.expiresInDays)) ||
      Number(options.expiresInDays) < 1 || Number(options.expiresInDays) > 365)) {
    throw Object.assign(error('USAGE', '--expires-in-days must be an integer from 1 to 365.'), { exitCode: 2 })
  }
  if (!options.tokenStdin) {
    const route = '/.well-known/specdoc'
    const discovery = await request(context, route)
    if (discovery?.protocolVersion !== 1 || discovery.role !== 'editor' ||
        discovery.capabilities?.deviceAuthorization !== true) throw unsupported(context, route)
  }
  const storage = await preflightStorage(context.config, 'author', options.storage)
  if (options.tokenStdin) {
    const secret = context.config.authorToken || await readToken(context.stdin)
    const identity = metadata(await request(context, '/api/v1/auth', { token: secret }))
    return installCredential(context, secret, identity, storage, false)
  }
  const aborter = new AbortController()
  const interrupted = () => aborter.abort()
  if (context.signals !== false) process.once('SIGINT', interrupted)
  if (context.signal) context.signal.addEventListener('abort', interrupted, { once: true })
  if (context.signal?.aborted) interrupted()
  let grant
  let installed = false
  try {
    grant = await request(context, '/oauth/device/code', {
      body: {
        client_id: CLIENT,
        scope: options.readOnly ? 'notes:read' : 'notes:read notes:write',
        name: options.name || `SpecDoc CLI (${context.config.profile})`,
        expires_in_days: Number(options.expiresInDays || 30)
      },
      signal: aborter.signal
    })
    const verificationUrl = validateGrant(grant, context.config)
    context.stderr.write(`Open this link to sign in:\n${verificationUrl}\nConfirm code: ${grant.user_code}\nWaiting for browser approval…\n`)
    if (options.openBrowser) openBrowser(verificationUrl, context)
    const now = context.now || Date.now
    const deadline = now() + grant.expires_in * 1000
    let interval = grant.interval * 1000
    while (now() < deadline) {
      try {
        await (context.sleep || delay)(Math.min(interval, deadline - now()), undefined, { signal: aborter.signal })
      } catch {
        throw error('INTERRUPTED', 'Login was interrupted.')
      }
      if (aborter.signal.aborted) throw error('INTERRUPTED', 'Login was interrupted.')
      if (now() >= deadline) break
      let authorized
      try {
        authorized = await request(context, '/oauth/token', {
          body: { client_id: CLIENT, grant_type: DEVICE_GRANT, device_code: grant.device_code },
          signal: aborter.signal
        })
      } catch (cause) {
        if (cause.code === 'authorization_pending') continue
        if (cause.code === 'slow_down') { interval += 5000; continue }
        // A failed exchange may have consumed the grant and issued a token.
        // Cancel and restart rather than minting or exposing a second secret.
        throw cause
      }
      const identity = metadata(authorized)
      const secret = checkedSecret(authorized.access_token)
      const result = await installCredential(context, secret, identity, storage, true)
      installed = true
      return result
    }
    throw error('expired_token', 'Login expired. Run auth login again.')
  } catch (cause) {
    if (cause.code === 'INTERRUPTED') cause.exitCode = 130
    if (grant?.device_code && !installed) {
      try {
        await request(context, '/oauth/device/cancel', { body: { client_id: CLIENT, device_code: grant.device_code }, timeout: 5000 })
        cause.details = { ...cause.details, cleanup: 'confirmed' }
      } catch {
        cause.details = { ...cause.details, cleanup: 'unconfirmed', tokenManagementUrl: serviceUrl(context.config, '/me/tokens') }
      }
    }
    throw cause
  } finally {
    if (context.signals !== false) process.removeListener('SIGINT', interrupted)
    context.signal?.removeEventListener('abort', interrupted)
  }
}

async function status (options, context) {
  const credential = await resolveCredential(context.config)
  const base = { profile: context.config.profile, editorOrigin: context.config.editorOrigin }
  if (!credential) throw error('AUTH_REQUIRED', 'No credential is configured. Run specdoc auth login.', { ...base, state: 'missing' })
  base.credentialSource = credential.source
  if (options.offline) {
    return { ...base, state: 'unverified', verified: false, ...(credential.metadata || {}) }
  }
  const identity = metadata(await request(context, '/api/v1/auth', { token: credential.secret }))
  return { ...base, state: 'authenticated', verified: true, ...identity }
}

async function logout (options, context) {
  const credential = await resolveCredential(context.config)
  const secret = credential?.secret
  let revoked = false
  let revocation = options.localOnly ? 'not-requested' : secret ? 'unconfirmed' : 'no-credential'
  if (secret && !options.localOnly) {
    try {
      const result = await request(context, '/api/v1/auth/token', { method: 'DELETE', token: secret })
      revoked = result.revoked === true
      revocation = revoked ? 'confirmed' : 'unconfirmed'
    } catch {}
  }
  const storedCredentialRetained = credential && credential.source !== 'stored' && Boolean(context.config.profileData?.credentials?.author)
  if ((!credential || credential.source === 'stored') && context.config.profileData?.credentials?.author) {
    await removeCredential(context.config)
    delete context.config.profileData.credentials.author
    persistProfile(context)
  }
  const environmentStillSet = credential?.source === 'environment'
  const external = credential && credential.source !== 'stored'
  return {
    profile: context.config.profile,
    state: external ? (revoked ? 'revoked' : 'unchanged') : 'logged-out',
    credentialSource: credential?.source || null,
    localRemoved: !external,
    revoked,
    revocation,
    environmentStillSet,
    storedCredentialRetained: Boolean(storedCredentialRetained)
  }
}

async function runAuth (action, options, context) {
  if (action === 'login') return login(options, context)
  if (action === 'status') return status(options, context)
  if (action === 'logout') return logout(options, context)
  throw Object.assign(error('USAGE', 'Unknown auth command.'), { exitCode: 2 })
}

module.exports = { runAuth }
