'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { OperationError, usage } = require('./errors')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function redact (value, token) {
  if (typeof value === 'string') return token ? value.split(token).join('[REDACTED]') : value
  if (Array.isArray(value)) return value.map(item => redact(item, token))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, token), redact(item, token)]))
  return value
}
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
function canonical (value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
  return value
}
function statusCode (status) {
  return ({ 400: 'INVALID_REQUEST', 401: 'AUTH_REQUIRED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 410: 'RECEIPT_EXPIRED', 412: 'PRECONDITION_FAILED', 428: 'PRECONDITION_REQUIRED', 429: 'RATE_LIMITED', 503: 'UNAVAILABLE' })[status] || 'HTTP_ERROR'
}
async function request (origin, route, { method = 'GET', token, body, headers = {}, timeout = 10000, fetch: fetcher = global.fetch } = {}) {
  const url = new URL(route, origin)
  if (url.origin !== origin) throw usage('Request origin does not match the configured service')
  let response
  try {
    response = await fetcher(url, { method, redirect: 'error', signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  } catch (e) { throw new OperationError('NETWORK_ERROR', 'The service could not be reached', { cause: e.name }) }
  let content = ''
  try {
    const reader = response.body?.getReader()
    if (reader) {
      const chunks = []; let length = 0
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        length += value.length
        if (length > 64 * 1024 * 1024) { await reader.cancel(); throw new OperationError('RESPONSE_TOO_LARGE', 'Response exceeded 64 MiB') }
        chunks.push(Buffer.from(value))
      }
      content = Buffer.concat(chunks).toString('utf8')
    } else content = await response.text()
  } catch (e) { if (e.code) throw e; throw new OperationError('NETWORK_ERROR', 'The response was interrupted') }
  let data = content
  if ((response.headers.get('content-type') || '').includes('json')) {
    try { data = JSON.parse(content) } catch { throw new OperationError('INVALID_RESPONSE', 'Service returned invalid JSON') }
  }
  if (!response.ok) {
    data = redact(data, token)
    const error = typeof data === 'object' && data && data.error
    const message = typeof error === 'string' ? error : error?.message || `Request failed (${response.status})`
    const result = new OperationError(typeof error === 'object' && error?.code || data?.code || statusCode(response.status), message, typeof data === 'object' ? data : undefined, response.status)
    const retryAfter = response.headers.get('retry-after')
    if (retryAfter) result.retryAfter = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())
    throw result
  }
  return { data, status: response.status, etag: response.headers.get('etag') }
}
function originFor (config, identity) {
  const origin = identity === 'author' ? config.editorOrigin : config.boardOrigin
  if (!origin) throw usage(`Configure ${identity === 'author' ? '--editor-url' : '--board-url'} or a profile first`)
  return origin
}
async function credential (config, identity) {
  const secret = config[identity === 'author' ? 'authorToken' : 'botToken'] || await require('./credentials').loadCredential(config, identity)
  if (!secret) throw new OperationError('AUTH_REQUIRED', identity === 'author' ? 'Run specdoc auth login for this editor origin' : 'Configure an origin-bound bot token for this board')
  return secret
}
function privateDirectory (directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid())) throw new OperationError('RECOVERY_PERMISSIONS', 'Recovery directories must be owned by you with permissions 0700')
}
function privateRecord (file, record) {
  privateDirectory(path.dirname(file))
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, file)
  } finally { try { fs.unlinkSync(temp) } catch (e) { if (e.code !== 'ENOENT') throw e } }
}
async function mutation (config, identity, route, method, body, headers = {}, key = crypto.randomUUID()) {
  if (!UUID.test(key)) throw usage('--operation-key must be a UUID')
  key = key.toLowerCase()
  const origin = originFor(config, identity)
  const token = await credential(config, identity)
  const fingerprint = digest(JSON.stringify(canonical({ origin, identity, route, method, body, headers })))
  const recordFile = path.join(config.configDir, 'operations', digest(`${config.profile}\0${origin}\0${identity}\0${key}`) + '.json')
  privateDirectory(config.configDir)
  privateDirectory(path.dirname(recordFile))
  try {
    const stat = fs.lstatSync(recordFile)
    if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid())) throw new OperationError('RECOVERY_PERMISSIONS', 'Recovery records must be private files owned by you')
    const existing = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
    if (existing.fingerprint !== fingerprint) throw new OperationError('IDEMPOTENCY_CONFLICT', 'Operation key already belongs to different request content')
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  const record = { version: 1, key, identity, origin, route, method, fingerprint, guard: headers['if-match'] || body.expectedHash || null, intendedDigest: digest(JSON.stringify(body)), state: 'pending', createdAt: new Date().toISOString() }
  privateRecord(recordFile, record)
  let receipts = false
  try { receipts = (await request(origin, '/.well-known/specdoc')).data?.capabilities?.publicReceipts === true } catch {}
  const deadline = Date.now() + 30000
  let lastError; let uncertain = false
  for (let attempt = 0; attempt < (receipts ? 3 : 1); attempt++) {
    try {
      const result = await request(origin, route, { method, token, body, headers: { ...headers, 'idempotency-key': key, prefer: 'return=minimal' }, timeout: Math.max(1, Math.min(10000, deadline - Date.now())) })
      const compact = result.data && typeof result.data === 'object' ? Object.fromEntries(Object.entries(result.data).filter(([key]) => !['content', 'body', 'source'].includes(key))) : {}
      let warning
      try { privateRecord(recordFile, { ...record, state: 'completed', completedAt: new Date().toISOString(), result: compact }) } catch { warning = 'The write succeeded, but its local recovery record could not be updated' }
      return { ...result, data: { ...(typeof result.data === 'object' && result.data !== null ? result.data : { result: result.data }), operationKey: key, ...(warning ? { warning } : {}) } }
    } catch (e) {
      lastError = e
      uncertain ||= ['NETWORK_ERROR', 'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE', 'OPERATION_PENDING'].includes(e.code) || e.status >= 500
      const retryable = ['NETWORK_ERROR', 'OPERATION_PENDING'].includes(e.code) || [429, 503].includes(e.status)
      if (!retryable || !receipts || attempt === 2) break
      const wait = Math.max(250 * (2 ** attempt), e.retryAfter || 0)
      if (Date.now() + wait >= deadline) break
      await new Promise(resolve => setTimeout(resolve, wait))
    }
  }
  if (uncertain) {
    try { privateRecord(recordFile, { ...record, state: 'unknown' }) } catch {}
    throw new OperationError('OUTCOME_UNKNOWN', 'The mutation outcome is unknown; recover the operation before submitting another write', { key, identity, origin, record: recordFile, recovery: `specdoc operation get ${key} --identity ${identity}`, cause: lastError.code })
  }
  try { privateRecord(recordFile, { ...record, state: 'failed', error: { code: lastError.code, status: lastError.status } }) } catch {}
  throw lastError
}
module.exports = { request, mutation, credential, originFor, digest, UUID, privateRecord, OperationError }
