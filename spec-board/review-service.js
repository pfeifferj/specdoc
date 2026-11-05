const { fail, digest } = require('./review-store')

const MAX_BODY = 8000
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
const publicPermission = value => value == null || ['freely', 'editable', 'locked'].includes(value)
const noteIdOf = value => {
  if (typeof value !== 'string' || !/^[\w-]{1,128}$/.test(value)) throw fail(400, 'Invalid note ID.')
  return value
}
const idOf = (value, label) => {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) throw fail(400, `Invalid ${label}.`)
  return value
}

function actorOf (actor) {
  const login = actor?.login || actor?.username
  if (actor?.provider !== 'github' || typeof actor.subject !== 'string' || !/^[1-9]\d{0,19}$/.test(actor.subject) ||
      typeof login !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(login)) {
    throw fail(401, 'A current GitHub identity from the editor is required.')
  }
  return { provider: 'github', subject: actor.subject, login }
}

function actionInput (action, input) {
  if (!['thread', 'reply', 'resolve', 'reopen'].includes(action)) throw fail(400, 'Unknown review action.')
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'Invalid review payload.')
  const allowed = action === 'thread' ? ['body', 'requestId'] : action === 'reply'
    ? ['threadId', 'version', 'body', 'requestId'] : ['threadId', 'version', 'requestId']
  if (Object.keys(input).some(key => !allowed.includes(key))) throw fail(400, 'Unknown review payload field.')
  if (typeof input.requestId !== 'string' || !/^[\w-]{16,128}$/.test(input.requestId)) throw fail(400, 'A request ID of 16 to 128 letters, digits, underscores or hyphens is required.')
  const payload = { requestId: input.requestId }
  if (action === 'thread' || action === 'reply') {
    if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > MAX_BODY || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.body)) {
      throw fail(400, `Write a discussion message of 1 to ${MAX_BODY} characters.`)
    }
    payload.body = input.body.trim()
  }
  if (action !== 'thread') {
    payload.threadId = idOf(input.threadId, 'thread ID')
    if (!Number.isSafeInteger(input.version) || input.version < 1 || input.version >= 2147483647) throw fail(400, 'A current discussion version is required.')
    payload.version = input.version
  }
  return { payload, requestHash: digest(JSON.stringify(stable({ action, payload: input }))) }
}

function pageOptions (options = {}) {
  const out = {}
  for (const field of ['after', 'activityAfter', 'threadId', 'messageAfter']) if (options[field] != null && options[field] !== '') out[field] = idOf(options[field], field)
  if (out.messageAfter && !out.threadId) throw fail(400, 'Message pagination requires a thread ID.')
  if (out.after && out.threadId) throw fail(400, 'Select a thread or a thread page, not both.')
  for (const [field, fallback, max] of [['limit', 20, 20], ['messageLimit', 20, 20], ['activityLimit', 50, 50]]) {
    const value = options[field] == null ? fallback : options[field]
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw fail(400, `Invalid ${field}.`)
    out[field] = value
  }
  return out
}

function sourceDTO (source) {
  return { id: source.id, title: String(source.title || '').slice(0, 500), namespace: source.namespace,
    owner: { subject: source.ownerSubject || null, login: String(source.ownerLogin || source.authorLogin || '').slice(0, 39) },
    contentHash: source.contentHash || (typeof source.content === 'string' ? digest(source.content) : null) }
}

function createReviewService ({ store, loadSource, authorize, prepareAuthorize = async () => undefined,
  notify = async () => {}, onNotificationError = () => {} }) {
  if (!store || typeof loadSource !== 'function' || typeof authorize !== 'function') throw new Error('Review storage, a fresh source loader and authorization are required')
  async function source (noteId, db, lock = false) {
    const current = await loadSource(noteId, db, { lock })
    if (!current || current.id !== noteId || !publicPermission(current.permission) || current.hidden === true) throw fail(404, 'Unknown spec.')
    if (typeof current.namespace !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(current.namespace)) throw fail(404, 'Unknown spec.')
    return current
  }

  async function act (noteId, who, action, input) {
    noteIdOf(noteId)
    const actor = actorOf(who)
    const { payload, requestHash } = actionInput(action, input)
    await store.admit(actor)
    const authorization = await prepareAuthorize({ actor, action, noteId })
    let current
    const result = await store.mutate({ noteId, actor, action, payload, requestHash,
      validate: async (db, thread, { replayed = false } = {}) => {
        current = await source(noteId, db, true)
        if (!await authorize({ actor, action, source: current, thread, db, authorization, replayed })) throw fail(403, 'You cannot perform this discussion action.')
      } })
    if (!result.replayed) {
      try { await notify({ ...result, actor, body: payload.body || null, source: sourceDTO(current) }) } catch (error) {
        try { onNotificationError(error) } catch (_) {}
      }
    }
    return result
  }

  async function read (noteId, options = {}) {
    noteIdOf(noteId)
    const parsed = pageOptions(options)
    let current
    const result = await store.read(noteId, parsed, async db => { current = await source(noteId, db) })
    current = await source(noteId)
    return { ...result, source: sourceDTO(current) }
  }

  async function context (noteId, options = {}) {
    noteIdOf(noteId)
    for (const [key, fallback, max] of [['maxBytes', 64000, 1000000], ['maxMessages', 200, 1000], ['maxThreads', 100, 500]]) {
      if (options[key] == null) options = { ...options, [key]: fallback }
      if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > max) throw fail(400, `Invalid ${key}.`)
    }
    const result = await store.context(noteId, options, db => source(noteId, db))
    await source(noteId)
    return result
  }

  return { act, read, context }
}

module.exports = { createReviewService, actorOf, actionInput, pageOptions, sourceDTO, MAX_BODY }
