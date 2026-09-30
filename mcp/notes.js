// Reads and writes one note as a board bot. The token is the bot's identity:
// the board scopes it to that bot's projects and every edit it accepts is a
// comment or a suggestion, never a direct change.
class Notes {
  constructor (url, token) {
    this.url = url.replace(/\/$/, '')
    this.token = token
  }

  async call (path, body) {
    const res = await fetch(`${this.url}/api/bot/notes/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    })
    const out = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`${res.status}: ${out.error || res.statusText}`)
    return out
  }

  read (id) {
    return this.call(encodeURIComponent(id))
  }

  write (id, action, body) {
    return this.call(`${encodeURIComponent(id)}/${action}`, body)
  }
}

module.exports = { Notes }
