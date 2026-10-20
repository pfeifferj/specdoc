'use strict'
const { request, mutation } = require('./client')
const { configDir, origin } = require('./config')
class Notes {
  constructor (url, token) {
    this.config = { profile: 'mcp', boardOrigin: origin(url), botToken: token, configDir: configDir(), env: process.env }
  }
  async read (id) {
    try { return (await request(this.config.boardOrigin, `/api/bot/notes/${encodeURIComponent(id)}`, { token: this.config.botToken })).data } catch (error) {
      if (error.status) error.message = `${error.status}: ${error.message}`
      throw error
    }
  }
  async write (id, action, body) {
    try {
      const { data } = await mutation(this.config, 'bot', `/api/bot/notes/${encodeURIComponent(id)}/${action}`, 'POST', body)
      const { operationKey, ...result } = data
      return result
    } catch (error) {
      if (error.status) error.message = `${error.status}: ${error.message}`
      throw error
    }
  }
}
module.exports = { Notes }
