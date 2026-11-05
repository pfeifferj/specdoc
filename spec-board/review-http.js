const crypto = require('crypto')

const fail = (status, message) => Object.assign(new Error(message), { status, reviewPublic: true })
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const actions = new Set(['thread', 'reply', 'resolve', 'reopen', 'summarize'])

function reviewIdentity (token, noteId, action, payload, verify, now = Date.now()) {
  const who = verify(token)
  if (!who || who.version !== 1 || who.purpose !== 'spec-review' || who.provider !== 'github' ||
      !Number.isSafeInteger(who.exp) || who.exp <= now || who.exp > now + 5 * 60000 + 30000 ||
      !/^[1-9]\d{0,19}$/.test(who.subject || '') || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(who.username || '') ||
      who.noteId !== noteId || who.action !== action || !actions.has(action) ||
      !payload || typeof payload !== 'object' || Array.isArray(payload) ||
      who.requestId !== payload.requestId || who.payloadHash !== digest(JSON.stringify(payload))) {
    throw fail(401, 'A current, payload-bound GitHub assertion from the editor is required.')
  }
  if (action === 'summarize' && (who.sourceHash !== payload.sourceHash || !/^[a-f0-9]{64}$/.test(payload.sourceHash || ''))) {
    throw fail(401, 'Save the current note before summarizing its proposed changes.')
  }
  return { provider: 'github', subject: who.subject, login: who.username,
    uid: who.id || who.uid || who.userId || null, exp: who.exp }
}

function createReviewHttp ({ origin, service, summary, loadSource, verify, readBody, record, admitSummary = async () => {}, enabled = true }) {
  const headers = { 'Access-Control-Allow-Origin': origin, 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  const send = (res, status, body) => res.writeHead(status, headers).end(JSON.stringify(body))

  async function response (noteId, url) {
    const options = {}
    for (const key of ['after', 'activityAfter', 'threadId', 'messageAfter']) {
      const value = url.searchParams.get(key)
      if (value) options[key] = value
    }
    const data = await service.read(noteId, options)
    const source = await loadSource(noteId)
    if (!source) throw fail(404, 'Unknown spec.')
    let generated
    try { generated = await summary.peek(noteId) } catch (_) {
      generated = { status: 'unavailable', message: 'A summary is not available for this comparison.' }
    }
    const current = await loadSource(noteId)
    if (!current) throw fail(404, 'Unknown spec.')
    if (current.contentHash !== source.contentHash || current.namespace !== source.namespace) {
      throw fail(409, 'The spec changed while loading its discussion. Reload it to continue.')
    }
    return { ...data, sourceHash: current.contentHash, summary: generated,
      approvals: await record(current, data.openDiscussions),
      discussionRestricted: current.permission === 'locked' || current.status === 'approved',
      permissions: { canComment: enabled, canGenerate: enabled },
      owner: { subject: current.ownerSubject || null, login: current.ownerLogin || '' } }
  }

  async function handle (req, res, noteId, url) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'content-type' }).end()
      return
    }
    try {
      if (req.method === 'GET') { send(res, 200, await response(noteId, url)); return }
      if (req.method !== 'POST') { send(res, 405, { error: 'Method not allowed.' }); return }
      if (!enabled) throw fail(503, 'The editor and board need a shared secret for review actions.')
      let body
      try { body = JSON.parse(await readBody(req, 60000)) } catch (_) { throw fail(400, 'Invalid review request.') }
      const { token, action, payload } = body || {}
      const actor = reviewIdentity(token, noteId, action, payload, verify)
      if (action === 'summarize') {
        if (Object.keys(payload).some(key => !['sourceHash', 'requestId'].includes(key)) ||
            !/^[\w-]{16,128}$/.test(payload.requestId || '')) throw fail(400, 'Invalid summary request.')
        await admitSummary(actor)
        send(res, 200, { summary: await summary.generate(noteId, { expectedHash: payload.sourceHash, actor }) })
      } else send(res, 200, await service.act(noteId, actor, action, payload))
    } catch (error) {
      const status = [400, 401, 403, 404, 409, 413, 422, 429, 502, 503].includes(error.status) ? error.status : 503
      const message = error.status === status && (status < 500 || error.reviewPublic || error.summaryError) ? error.message
        : 'The review action could not be completed. Keep your draft and try again shortly.'
      const code = typeof error.code === 'string' && /^review-[a-z-]+$/.test(error.code) ? error.code : undefined
      send(res, status, { error: message, code })
    }
  }

  return { handle }
}

module.exports = { createReviewHttp, reviewIdentity }
