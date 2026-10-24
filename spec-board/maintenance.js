'use strict'

const { Pool } = require('pg')
const { planRedaction, redactHistory } = require('./history-redaction')

async function main (args) {
  if (args.shift() !== 'redact-history') throw new Error('Usage: node maintenance.js redact-history --note ID [--note ID] [--apply --offline --actor GITHUB_ID --reason TEXT --expected-hash ID=SHA256]')
  const options = { notes: [], expectedHashes: {} }
  let apply = false
  while (args.length) {
    const flag = args.shift()
    if (flag === '--apply') { apply = true; continue }
    if (flag === '--offline') { options.offline = true; continue }
    if (!['--note', '--actor', '--reason', '--expected-hash'].includes(flag)) throw new Error(`Unknown option: ${flag}`)
    const value = args.shift()
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    if (flag === '--note') options.notes.push(value)
    if (flag === '--actor') options.actor = value
    if (flag === '--reason') options.reason = value
    if (flag === '--expected-hash') {
      const match = /^([A-Za-z0-9_-]{1,128})=([a-f0-9]{64})$/.exec(value)
      if (!match || options.expectedHashes[match[1]]) throw new Error('Expected hashes must be unique NOTE_ID=SHA256 pairs')
      options.expectedHashes[match[1]] = match[2]
    }
  }
  if (!process.env.MAINTENANCE_DATABASE_URL) throw new Error('Set MAINTENANCE_DATABASE_URL to the offline owner connection with board,editor search_path')
  const db = new Pool({ connectionString: process.env.MAINTENANCE_DATABASE_URL, max: 1, statement_timeout: 60000 })
  try {
    const result = apply ? await redactHistory(db, options) : { applied: false, ...await planRedaction(db, options.notes) }
    console.log(JSON.stringify(result, null, 2))
  } finally { await db.end() }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { main }
