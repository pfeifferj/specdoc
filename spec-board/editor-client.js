const crypto = require('crypto')

const contentHash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

function createEditorClient ({ url, secret, timeout = 15000, signal, fetch: request = global.fetch }) {
  return async function mutate (mutation) {
    if (!secret) throw Object.assign(new Error('Editor mutation secret is not configured'), { status: 503 })
    // JSONB may reorder a recovered intent; receipt identity uses wire bytes.
    const fields = ['operationId', 'noteId', 'expectedHash', 'expectedPermission', 'operation', 'content', 'permission', 'expectedLockId']
    const body = JSON.stringify({ version: 1, ...Object.fromEntries(fields.filter(key => mutation[key] !== undefined).map(key => [key, mutation[key]])) })
    const claims = Buffer.from(JSON.stringify({ version: 1, purpose: 'spec-board-mutation', bodyHash: contentHash(body), exp: Date.now() + 60000 })).toString('base64url')
    const signature = crypto.createHmac('sha256', secret).update(claims).digest('base64url')
    const response = await request(`${url.replace(/\/$/, '')}/internal/spec-board/v1/mutate`, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${claims}.${signature}` },
      body, signal: signal ? signal(timeout) : AbortSignal.timeout(timeout)
    })
    if (!response.ok) throw Object.assign(new Error(`Editor mutation refused (${response.status})`), { status: response.status })
    const result = await response.json()
    if (result.version !== 1 || result.noteId !== mutation.noteId || !/^[a-f0-9]{64}$/.test(result.contentHash) ||
        typeof result.applied !== 'boolean' || ![null, 'freely', 'editable', 'locked', 'limited', 'protected', 'private'].includes(result.permission)) {
      throw new Error('Editor mutation returned an incompatible response')
    }
    return result
  }
}

module.exports = { createEditorClient, contentHash }
