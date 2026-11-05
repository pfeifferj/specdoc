'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { verifiedEmails, notificationEmail } = require('./notification-address')

const profile = emails => JSON.stringify({ provider: 'github', id: '42', emails })
assert.equal(notificationEmail({ email: 'victim@example.test', profile: null }), '')
assert.equal(notificationEmail({ profile: '{"emails":["victim@example.test"]}' }), '')
assert.equal(notificationEmail({ profile: profile([{ value: 'victim@example.test', verified: false }]) }), '')
assert.deepEqual(verifiedEmails(JSON.stringify({ provider: 'other', id: '42', emails: [{ value: 'victim@example.test', verified: true }] })), [])
const account = { email: 'victim@example.test', profile: profile([{ value: 'old@example.test', verified: false },
  { value: 'SECONDARY@example.test', verified: true }, { value: 'PRIMARY@example.test', primary: true, verified: true }]) }
assert.equal(notificationEmail(account), 'primary@example.test', 'an unverified preference cannot select another recipient')
assert.equal(notificationEmail({ ...account, email: 'secondary@example.test' }), 'secondary@example.test')
assert.deepEqual(verifiedEmails(profile([{ value: 'victim@example.test,second@example.test', verified: true }])), [])

process.env.WEBHOOK_URL = 'https://webhook.test/sink'
const file = path.join(__dirname, 'server.js')
const fixture = new Module(file + '.notification-security', module)
fixture.filename = file
fixture.paths = Module._nodeModulePaths(__dirname)
const realRequire = fixture.require.bind(fixture)
const events = []
let restricted = false
fixture.require = id => id === './moderation' ? { ...realRequire(id), assertAutomationContext: async (db, ids) => {
  events.push({ gate: ids })
  if (restricted) throw Object.assign(new Error('Content is no longer public or is restricted'), { status: 403 })
} } : realRequire(id)
fixture._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.notify=notify;', file)
const originalFetch = global.fetch
global.fetch = async (url, options) => { events.push({ request: JSON.parse(options.body) }); return { ok: true } }
async function main () {
  try {
    await fixture.exports.notify('Spec title @everyone <@123>', ['first', 'second'])
    assert.deepEqual(events.map(value => Object.keys(value)[0]), ['gate', 'request'])
    assert.deepEqual(events[0].gate, ['first', 'second'])
    assert.deepEqual(events[1].request.allowed_mentions, { parse: [] })
    assert.equal(events[1].request.text.includes('@'), false)
    events.length = 0
    restricted = true
    await fixture.exports.notify('Private or hidden spec title', ['first'])
    assert.deepEqual(events, [{ gate: ['first'] }], 'current private, hidden, deleted or suspended content never reaches the webhook')
    events.length = 0
    await fixture.exports.notify('Operational preflight failure')
    assert.equal(events.length, 1)
    assert.ok(events[0].request)
    events.length = 0
    await fixture.exports.botFailed({ name: 'reviewer' }, new Error('Unexpected JSON containing private note text'))
    assert.equal(events[0].request.text, 'Review bot reviewer failing: request failed')
    console.log('Verified notification addresses, preference revocation, and final note-scoped webhook gate passed')
  } finally { global.fetch = originalFetch }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
