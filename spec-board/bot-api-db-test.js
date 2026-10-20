const assert = require('assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { Readable } = require('stream')
const { Pool } = require('pg')
const { contentHash } = require('./editor-client')
const connectionString = process.env.AUDIT_TEST_DATABASE_URL
if (!connectionString) { console.error('Set AUDIT_TEST_DATABASE_URL to an explicit PostgreSQL test database.'); process.exit(1) }
process.env.NAMESPACES = 'team/specs,other/specs'
process.env.DEFAULT_NAMESPACE = 'team/specs'
process.env.EDITOR_SECRET = 'bot-api-tests-only'
process.env.GITHUB_TOKEN = 'test-token-never-sent'
delete process.env.WEBHOOK_URL
delete process.env.SMTP_HOST

async function main () {
  const schema = 'bot_api_test_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  let db
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 })
    await db.query('CREATE TABLE "Notes" (id uuid PRIMARY KEY, shortid text UNIQUE, content text, permission text)')
    await db.query('CREATE TABLE "Users" (id uuid PRIMARY KEY, profile text, profileid text, email text)')
    await db.query('CREATE TABLE test_editor_receipts (id uuid PRIMARY KEY)')
    let busy = false
    let loseResponse = false
    async function mutation (body) {
      if (busy) throw Object.assign(new Error('busy'), { status: 409 })
      if ((await db.query('SELECT 1 FROM test_editor_receipts WHERE id=$1', [body.operationId])).rowCount) return { version: 1, applied: true }
      const { rows: [note] } = await db.query('SELECT content, permission FROM "Notes" WHERE shortid=$1', [body.noteId])
      if (contentHash(note.content) !== body.expectedHash || note.permission !== body.expectedPermission) throw Object.assign(new Error('changed'), { status: 412 })
      await db.query('UPDATE "Notes" SET content=$1 WHERE shortid=$2', [body.content, body.noteId])
      await db.query('INSERT INTO test_editor_receipts VALUES ($1)', [body.operationId])
      if (loseResponse) throw new Error('response lost after commit')
      return { version: 1, applied: true }
    }
    const file = path.join(__dirname, 'server.js')
    const mod = new Module(file + '.bot-api-test', module)
    mod.filename = file
    mod.paths = Module._nodeModulePaths(__dirname)
    const realRequire = mod.require.bind(mod)
    mod.require = id => {
      if (id === 'pg') return { Pool: class { constructor () { return db } } }
      if (id === './editor-client') return { contentHash, createEditorClient: () => mutation }
      return realRequire(id)
    }
    mod._compile(fs.readFileSync(file, 'utf8') + `
      module.exports.fixture = { ensureState, loadState, loadBots, botApi, upsertState,
        cache: (specs, state) => { snapshot = { specs, state, graph: [], at: Date.now() } } };`, file)
    const api = mod.exports, fixture = api.fixture
    global.fetch = async () => { throw new Error('no network in this test') }
    await fixture.ensureState()

    const token = crypto.randomBytes(32).toString('base64url')
    await db.query("INSERT INTO spec_board_bots (name, namespaces, token_hash) VALUES ('local', 'team/specs', $1)", [api.tokenHash(token)])
    await db.query("INSERT INTO spec_board_bots (name, url, model, namespaces) VALUES ('hosted', 'https://m.test', 'm', 'team/specs')")
    assert.deepEqual((await fixture.loadBots()).map(b => b.name), ['hosted'], 'a token-only bot never reviews from the poller')

    const text = '---\ntags: [spec, in-review]\nnamespace: team/specs\n---\n# Review\n\nThe daemon starts first.{>>@alice: why?<<}\n\nOther text.\n'
    await db.query('INSERT INTO "Notes" VALUES ($1,$2,$3,$4)', [crypto.randomUUID(), 'note-one', text, 'editable'])
    const spec = { ...api.specsFromRows([{ shortid: 'note-one', content: text, permission: 'editable' }])[0], url: 'https://notes.test/note-one' }
    await fixture.upsertState({ id: spec.id, namespace: spec.namespace, status: 'in-review' }, db)
    const view = () => ({ specs: [spec], state: new Map() })

    let requestNumber = 0
    async function call (method, route, body, auth = token, headers = {}) {
      const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
      Object.assign(req, { method, headers: { ...(auth ? { authorization: 'Bearer ' + auth } : {}), ...headers }, socket: { remoteAddress: '127.0.0.' + (++requestNumber) } })
      const res = { writeHead (code) { this.code = code; return this }, end (value) { this.body = JSON.parse(value); return this } }
      await fixture.botApi(req, res, new URL('http://board.test' + (route.startsWith('/') ? route : '/api/bot/notes/' + route)), view())
      return res
    }
    const content = async () => (await db.query('SELECT content FROM "Notes"')).rows[0].content

    assert.equal((await call('GET', 'note-one', undefined, null)).code, 401)
    assert.equal((await call('GET', 'note-one', undefined, 'x'.repeat(43))).code, 401)
    const read = await call('GET', 'note-one')
    assert.equal(read.code, 200)
    assert.equal(read.body.content, text)
    assert.equal(read.body.hash, contentHash(text))
    assert.equal(read.body.status, 'in-review')
    assert.equal(read.body.threads.length, 1)

    const commented = await call('POST', 'note-one/comments', { expectedHash: read.body.hash, comments: [{ quote: 'Other text.', text: 'vague' }] })
    assert.equal(commented.code, 200)
    assert.ok((await content()).includes('Other text.{>>@local: vague<<}'))
    assert.equal(commented.body.hash, contentHash(await content()))
    assert.equal((await call('POST', 'note-one/comments', { expectedHash: read.body.hash, comments: [{ text: 'stale' }] })).code, 409, 'a stale hash writes nothing')

    const replied = await call('POST', 'note-one/replies', { expectedHash: commented.body.hash, thread: read.body.threads[0].id, text: 'socket ordering' })
    assert.equal(replied.code, 200)
    assert.ok((await content()).includes('{>>@alice: why?<<}{>>@local: socket ordering<<}'))
    assert.equal((await call('POST', 'note-one/replies', { expectedHash: replied.body.hash, thread: 'comment-00000000', text: 'x' })).code, 404)

    busy = true
    assert.equal((await call('POST', 'note-one/suggestions', { expectedHash: replied.body.hash, suggestions: [{ quote: 'Review', replacement: 'Scope', rationale: 'r' }] })).code, 409)
    busy = false
    const suggested = await call('POST', 'note-one/suggestions', { expectedHash: replied.body.hash, suggestions: [{ quote: 'The daemon', replacement: 'The service', rationale: 'term of art' }] })
    assert.equal(suggested.code, 200)
    assert.equal(suggested.body.placed, 1)
    assert.ok((await content()).includes('{~~The daemon~>The service~~}{>>@local: term of art<<}'))

    const key = crypto.randomUUID()
    const keyedHeaders = { 'idempotency-key': key, prefer: 'return=minimal' }
    const keyedBody = { expectedHash: contentHash(await content()), thread: read.body.threads[0].id, text: 'durable reply' }
    assert.equal((await call('POST', 'note-one/replies', keyedBody, token, { 'idempotency-key': key })).code, 400)
    assert.equal((await call('POST', 'note-one/replies', keyedBody, token, { ...keyedHeaders, 'idempotency-key': 'invalid' })).code, 400)
    const firstKeyed = await call('POST', 'note-one/replies', keyedBody, token, keyedHeaders)
    assert.equal(firstKeyed.code, 200, JSON.stringify(firstKeyed.body))
    const firstText = await content()
    const replay = await call('POST', 'note-one/replies', { ...keyedBody, text: 'durable   reply' }, token, keyedHeaders)
    assert.equal(replay.code, 200)
    assert.deepEqual(replay.body, firstKeyed.body)
    assert.equal(await content(), firstText)
    assert.equal((await call('POST', 'note-one/replies', { ...keyedBody, text: 'different' }, token, keyedHeaders)).code, 409)
    const receipt = await call('GET', '/api/bot/operations/' + key)
    assert.equal(receipt.code, 200)
    assert.equal(receipt.body.state, 'completed')
    assert.deepEqual(receipt.body.result, firstKeyed.body)
    assert.equal(JSON.stringify(receipt.body).includes('durable reply'), false)

    const lostKey = crypto.randomUUID()
    const lostHeaders = { ...keyedHeaders, 'idempotency-key': lostKey }
    const lostBody = { ...keyedBody, expectedHash: contentHash(firstText), text: 'lost-response reply' }
    loseResponse = true
    assert.equal((await call('POST', 'note-one/replies', lostBody, token, lostHeaders)).code, 503)
    assert.equal((await call('GET', '/api/bot/operations/' + lostKey)).code, 202)
    const committed = await content()
    loseResponse = false
    assert.equal((await call('POST', 'note-one/replies', lostBody, token, lostHeaders)).code, 200)
    assert.equal(await content(), committed)
    assert.equal((committed.match(/lost-response reply/g) || []).length, 1)

    await db.query('UPDATE "Notes" SET content=$1', [committed.replace('in-review', 'approved')])
    assert.equal((await call('POST', 'note-one/replies', keyedBody, token, keyedHeaders)).code, 200, 'receipt replay precedes changed lifecycle and guard checks')
    assert.equal((await call('POST', 'note-one/comments', {
      expectedHash: contentHash(await content()), comments: [{ text: 'new comment' }]
    }, token, { ...keyedHeaders, 'idempotency-key': crypto.randomUUID() })).code, 409, 'live approval state wins over stale snapshot')
    const suggestionKey = crypto.randomUUID()
    const suggestionBody = { expectedHash: contentHash(await content()), suggestions: [{ quote: 'absent quote', replacement: 'new wording', rationale: 'unanchored proposal' }] }
    const suggestionHeaders = { ...keyedHeaders, 'idempotency-key': suggestionKey }
    const keyedSuggestion = await call('POST', 'note-one/suggestions', suggestionBody, token, suggestionHeaders)
    assert.equal(keyedSuggestion.code, 200)
    assert.equal(keyedSuggestion.body.unanchored, 1)
    assert.ok((await content()).includes('in-review'), 'keyed suggestions reopen approval using live metadata')
    assert.deepEqual((await call('POST', 'note-one/suggestions', suggestionBody, token, suggestionHeaders)).body, keyedSuggestion.body)
    const commentKey = crypto.randomUUID()
    const commentBody = { expectedHash: contentHash(await content()), comments: [{ text: 'durable comment' }] }
    const commentHeaders = { ...keyedHeaders, 'idempotency-key': commentKey }
    const keyedComment = await call('POST', 'note-one/comments', commentBody, token, commentHeaders)
    assert.equal(keyedComment.code, 200)
    assert.deepEqual((await call('POST', 'note-one/comments', commentBody, token, commentHeaders)).body, keyedComment.body)

    const otherToken = crypto.randomBytes(32).toString('base64url')
    await db.query("INSERT INTO spec_board_bots (name, namespaces, token_hash) VALUES ('other', 'team/specs', $1)", [api.tokenHash(otherToken)])
    assert.equal((await call('GET', '/api/bot/operations/' + key, undefined, otherToken)).code, 404)
    await db.query("UPDATE \"Notes\" SET permission = 'private'")
    assert.equal((await call('GET', '/api/bot/operations/' + key)).code, 404)
    assert.equal((await call('POST', 'note-one/replies', keyedBody, token, keyedHeaders)).code, 404)
    await db.query("UPDATE \"Notes\" SET permission = 'editable'")
    await db.query("UPDATE spec_board_bots SET namespaces = 'other/specs' WHERE name = 'local'")
    assert.equal((await call('GET', '/api/bot/operations/' + key)).code, 404)
    assert.equal((await call('GET', 'note-one')).code, 404, 'a bot reads only its own projects')
    await db.query("UPDATE spec_board_bots SET namespaces = 'team/specs', enabled = false WHERE name = 'local'")
    assert.equal((await call('GET', '/api/bot/operations/' + key)).code, 401)
    assert.equal((await call('GET', 'note-one')).code, 401, 'a disabled bot has no access')
    await db.query("UPDATE spec_board_bots SET enabled = true, token_hash = NULL WHERE name = 'local'")
    assert.equal((await call('GET', 'note-one')).code, 401, 'a revoked token has no access')

    console.log('bot api database integration tests passed')
  } finally {
    if (db) await db.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
