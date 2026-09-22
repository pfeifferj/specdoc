const assert = require('assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { Readable } = require('stream')
const { Pool } = require('pg')
const { contentHash } = require('./editor-client')
const { publicationGuard } = require('./schema-guard')
const connectionString = process.env.AUDIT_TEST_DATABASE_URL
if (!connectionString) { console.error('Set AUDIT_TEST_DATABASE_URL to an explicit PostgreSQL test database.'); process.exit(1) }
process.env.NAMESPACES = 'team/specs,other/specs'
process.env.DEFAULT_NAMESPACE = 'team/specs'
process.env.EDITOR_SECRET = 'audit-tests-only'
process.env.GITHUB_TOKEN = 'test-token-never-sent'
delete process.env.SMTP_HOST

async function main () {
  const schema = 'audit_test_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  let db
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 })
    await db.query('CREATE TABLE "Notes" (id uuid PRIMARY KEY, shortid text UNIQUE, content text, permission text)')
    await db.query('CREATE TABLE "Users" (id uuid PRIMARY KEY, profile text, profileid text, email text)')
    let lostResponse = false, changes = 0, lockId = null, beforeReturn = null
    const receipts = new Map()
    async function mutation (body) {
      if (receipts.has(body.operationId)) return receipts.get(body.operationId)
      const { rows: [note] } = await db.query('SELECT content, permission FROM "Notes" WHERE shortid=$1', [body.noteId])
      const result = { version: 1, noteId: body.noteId, contentHash: contentHash(note.content), permission: note.permission, applied: false }
      if (Object.hasOwn(body, 'expectedLockId') && (!body.expectedLockId || body.expectedLockId !== lockId)) {
        result.superseded = true
      } else {
        if (contentHash(note.content) !== body.expectedHash || note.permission !== body.expectedPermission) throw Object.assign(new Error('changed'), { status: 412 })
        await db.query('UPDATE "Notes" SET permission=$1 WHERE shortid=$2', [body.permission, body.noteId])
        changes++
        lockId = Object.hasOwn(body, 'expectedLockId') ? null : body.operationId
        Object.assign(result, { permission: body.permission, applied: true, lockId })
      }
      receipts.set(body.operationId, result)
      if (lostResponse) { lostResponse = false; throw new Error('response lost') }
      if (beforeReturn) {
        const wait = beforeReturn
        beforeReturn = null
        await wait()
      }
      return result
    }
    const file = path.join(__dirname, 'server.js')
    const mod = new Module(file + '.audit-test', module)
    mod.filename = file
    mod.paths = Module._nodeModulePaths(__dirname)
    const realRequire = mod.require.bind(mod)
    mod.require = id => {
      if (id === 'pg') return { Pool: class { constructor () { return db } } }
      if (id === './editor-client') return { contentHash, createEditorClient: () => mutation }
      return realRequire(id)
    }
    mod._compile(fs.readFileSync(file, 'utf8') + `
      module.exports.fixture = { ensureState, noteApprovalPost, reconcilePermission, loadState, loadSnapshots,
        reviewFingerprint, reviewerIdentities, rolesForSpecs, withAdvisoryLock, assertWorkAllowed,
        saveConflicts, attachConflicts, dropStaleConflicts, loadReviews,
        loseLease: () => leadership.abort(new Error('connection lost')),
        cache: (specs, state) => { snapshot = { specs, state, graph: [], at: Date.now() } } };`, file)
    const api = mod.exports, fixture = api.fixture
    let liveRoles = { approvers: ['reviewer'], 'approvals-required': 1 }
    global.fetch = async (url, options) => {
      assert.ok(url.endsWith('/repos/team/specs/contents/.specs/roles.yml'), 'only the isolated roles stub may be called')
      if (!liveRoles) throw new Error('GitHub unavailable')
      return { ok: true, headers: { get: () => null }, json: async () => ({ content: Buffer.from(JSON.stringify(liveRoles)).toString('base64') }) }
    }
    await fixture.ensureState()
    assert.equal((await publicationGuard(db)).ready, true)
    await db.query('INSERT INTO "Users" VALUES ($1,$2,$3,$4),($5,$6,$7,$8)', [
      crypto.randomUUID(), JSON.stringify({ provider: 'github', id: '1234', username: 'reviewer' }), 'github:1234', 'real@example.test',
      crypto.randomUUID(), JSON.stringify({ provider: 'gitlab', id: '1234', username: 'reviewer' }), 'gitlab:1234', 'other@example.test'])
    assert.equal((await fixture.reviewerIdentities(['reviewer'])).get('reviewer').email, 'real@example.test')
    const text = '---\ntags: [spec, in-review]\nnamespace: team/specs\n---\n# Review\n\nExact reviewed text.\n'
    const id = crypto.randomUUID()
    await db.query('INSERT INTO "Notes" VALUES ($1,$2,$3,$4)', [id, 'note-one', text, 'editable'])
    const makeSpec = content => ({ ...api.specsFromRows([{ id, shortid: 'note-one', content, permission: 'editable' }])[0],
      approvers: ['reviewer'], approvedBy: [], required: 1, approvals: 1, staleApprovals: [], url: 'https://notes.test/note-one' })
    const spec = makeSpec(text)
    await api.upsertState({ id: spec.id, namespace: spec.namespace, status: 'in-review' }, db)
    fixture.cache([spec], await fixture.loadState())
    const claims = { version: 1, purpose: 'spec-approval', provider: 'github', subject: '1234', username: 'reviewer',
      noteId: spec.id, action: 'approve', contentHash: contentHash(text), exp: Date.now() + 60000 }
    async function approve (who = claims, action = 'approve') {
      const req = Readable.from([JSON.stringify({ action, token: api.signToken(who, process.env.EDITOR_SECRET) })])
      const res = { writeHead (code) { this.code = code; return this }, end (value) { this.body = JSON.parse(value); return this } }
      await fixture.noteApprovalPost(req, res, spec)
      return res
    }
    assert.equal((await approve({ ...claims, purpose: 'spec-board-mutation' })).code, 401)
    assert.equal((await approve({ ...claims, provider: 'gitlab' })).code, 401)
    assert.equal((await approve({ ...claims, noteId: 'other-note' })).code, 401)
    liveRoles = { approvers: ['someone-else'] }
    assert.equal((await approve()).code, 403, 'cached approvers cannot override a revoked role')
    liveRoles = null
    assert.equal((await approve()).code, 503, 'role fetch failure does not authorize a cached roster')
    const staleRolesSpec = (await fixture.rolesForSpecs([makeSpec(text)]))[0]
    assert.equal(staleRolesSpec.rolesUnknown, true)
    assert.equal(api.canApprove(staleRolesSpec), false, 'failed cached roles cannot authorize publication')
    liveRoles = { approvers: ['reviewer'], 'approvals-required': 1 }
    assert.equal((await approve()).code, 200)
    const approved = (await db.query("SELECT hash FROM spec_board_snapshots WHERE kind='approval'")).rows[0].hash
    assert.equal(approved, api.publishedHash(api.publishedBody(spec)))
    const writer = await db.connect()
    try {
      await writer.query('BEGIN')
      await writer.query('SELECT content FROM "Notes" WHERE shortid=$1 FOR UPDATE', [spec.id])
      const attempt = approve()
      await writer.query('UPDATE "Notes" SET content=$1 WHERE shortid=$2', [text + 'Changed after acknowledgement.\n', spec.id])
      await writer.query('COMMIT')
      assert.equal((await attempt).code, 409, 'approval sees the edit committed ahead of its row lock')
    } finally { writer.release() }
    assert.equal((await db.query("SELECT hash FROM spec_board_snapshots WHERE kind='approval'")).rows[0].hash, approved)
    await db.query('UPDATE "Notes" SET content=$1, permission=$2 WHERE shortid=$3', [text, 'private', spec.id])
    assert.equal((await approve()).code, 404)
    await db.query('UPDATE "Notes" SET permission=$1 WHERE shortid=$2', ['editable', spec.id])

    let prev = (await fixture.loadState()).get(spec.id)
    lostResponse = true
    await assert.rejects(fixture.reconcilePermission(spec, prev, 'approved'), /response lost/)
    prev = (await fixture.loadState()).get(spec.id)
    assert.equal(prev.permission_intent.plan.prelockPermission, 'editable')
    assert.equal(prev.locked_at, null)
    assert.equal(changes, 1)
    await fixture.reconcilePermission(spec, prev, 'in-review')
    assert.equal(changes, 1, 'opposing intent first reconciles the completed lock')
    assert.equal(prev.prelock_permission, 'editable')
    await fixture.reconcilePermission(spec, prev, 'in-review')
    assert.equal(changes, 2)
    assert.equal((await db.query('SELECT permission FROM "Notes"')).rows[0].permission, 'editable')
    assert.equal(prev.locked_at, null)

    await db.query('UPDATE "Notes" SET permission=$1 WHERE shortid=$2', ['editable', spec.id])
    spec.permission = 'editable'
    let reply, reached
    const paused = new Promise(resolve => { reached = resolve })
    const releaseReply = new Promise(resolve => { reply = resolve })
    beforeReturn = async () => { reached(); await releaseReply }
    const delayed = fixture.reconcilePermission(spec, prev, 'approved')
    await paused
    const nextSpec = makeSpec(text)
    nextSpec.permission = 'locked'
    const nextPrev = (await fixture.loadState()).get(spec.id)
    await fixture.reconcilePermission(nextSpec, nextPrev, 'in-review')
    await fixture.reconcilePermission(nextSpec, nextPrev, 'in-review')
    await fixture.reconcilePermission(nextSpec, nextPrev, 'approved')
    const newerLock = nextPrev.permission_lock_id
    reply()
    await delayed
    assert.equal((await fixture.loadState()).get(spec.id).permission_lock_id, newerLock, 'late acknowledgement cannot replace a newer lock')
    assert.equal(prev.permission_lock_id, newerLock, 'old poll view refreshes from the current state')
    await fixture.reconcilePermission(nextSpec, nextPrev, 'in-review')
    assert.equal((await db.query('SELECT permission FROM "Notes"')).rows[0].permission, 'editable', 'new lock remains releasable')
    Object.assign(prev, nextPrev)
    spec.permission = 'editable'
    const beforeFinalLock = changes

    await db.query('ALTER TABLE spec_board_state ADD CONSTRAINT fail_finish CHECK (locked_at IS NULL OR permission_intent IS NOT NULL)')
    await assert.rejects(fixture.reconcilePermission(spec, prev, 'approved'), /fail_finish/)
    assert.equal(changes, beforeFinalLock + 1)
    await db.query('ALTER TABLE spec_board_state DROP CONSTRAINT fail_finish')
    prev = (await fixture.loadState()).get(spec.id)
    await fixture.reconcilePermission(spec, prev, 'approved')
    assert.equal(changes, beforeFinalLock + 1, 'database failure reuses the editor receipt')
    lockId = null
    await fixture.reconcilePermission(spec, prev, 'in-review')
    assert.equal(changes, beforeFinalLock + 1, 'owner permission override is preserved')
    assert.equal(prev.locked_at, null)

    const pinned = api.specsFromRows([{ id, shortid: spec.id, content: text.replace('team/specs', 'other/specs') + '\n', permission: 'editable' }],
      new Map([[spec.id, { namespace: 'team/specs', pr_number: 42 }]]))[0]
    assert.equal(pinned.namespace, 'team/specs')
    const bot = { url: 'https://model.test', model: 'model', prompt: 'review' }
    const fingerprint = fixture.reviewFingerprint(bot, 'Text.', 'Principles.')
    for (const changed of [{ ...bot, model: 'new' }, { ...bot, prompt: 'new' }, { ...bot, url: 'https://other.test' }]) {
      assert.notEqual(fixture.reviewFingerprint(changed, 'Text.', 'Principles.'), fingerprint)
    }
    assert.notEqual(fixture.reviewFingerprint(bot, 'Text.', 'Changed principles.'), fingerprint)
    assert.equal(fixture.reviewFingerprint({ ...bot, api_key: 'new-secret' }, 'Text.', 'Principles.'), fingerprint)

    await assert.rejects(fixture.withAdvisoryLock(false, async () => {
      fixture.loseLease()
      assert.throws(fixture.assertWorkAllowed, /leadership loss/)
      await api.upsertState({ id: spec.id, publishedCommit: 'acknowledged-remote-result' }, db)
    }), /leadership connection/)
    assert.equal((await fixture.loadState()).get(spec.id).published_commit, 'acknowledged-remote-result')

    await db.query('DROP INDEX spec_board_state_ns_pr')
    await db.query('CREATE INDEX spec_board_state_ns_pr ON spec_board_state(namespace)')
    assert.equal((await publicationGuard(db)).ready, false)
    await db.query('DROP INDEX spec_board_state_ns_pr')
    await db.query('CREATE UNIQUE INDEX spec_board_state_ns_pr ON spec_board_state(namespace, pr_number, lower(note_id)) WHERE pr_number IS NOT NULL')
    assert.equal((await publicationGuard(db)).ready, false, 'extra expression keys weaken uniqueness')
    await db.query('DROP INDEX spec_board_state_ns_pr')
    await api.upsertState({ id: spec.id, prNumber: 42 }, db)
    await api.upsertState({ id: 'duplicate', namespace: 'team/specs', prNumber: 42 }, db)
    assert.equal((await publicationGuard(db)).ready, false)
    await db.query('DELETE FROM spec_board_state WHERE note_id=$1', ['duplicate'])
    assert.equal((await publicationGuard(db)).ready, true)
    assert.equal((await publicationGuard({ query: async () => { throw new Error('migration timeout') } })).ready, false)

    // Advisory conflict findings: written beside the note, replaced whole per
    // bot, and swept when no later review can refresh them.
    await db.query('DELETE FROM spec_board_state WHERE note_id=$1', [spec.id])
    await api.upsertState({ id: spec.id, namespace: spec.namespace, status: 'in-review' }, db)
    await db.query("INSERT INTO spec_board_bots (name, url, model, namespaces) VALUES ('net-gpt','http://bot.invalid','m','team/specs'), ('other','http://bot.invalid','m','team/specs')")
    const rows = async () => (await db.query('SELECT note_id, bot_name, peer_n, quote, why FROM spec_board_conflicts ORDER BY bot_name, peer_n')).rows
    const carrier = { id: spec.id }
    await fixture.saveConflicts(carrier, 'net-gpt', [{ n: 7, quote: 'a line', why: 'issue: clashes' }])
    assert.deepEqual(await rows(), [{ note_id: spec.id, bot_name: 'net-gpt', peer_n: 7, quote: 'a line', why: 'issue: clashes' }])
    assert.deepEqual(carrier.conflicts, [{ n: 7, quote: 'a line', why: 'issue: clashes', bot: 'net-gpt' }])

    // A second bot's findings sit alongside; replacing one leaves the other.
    await fixture.saveConflicts(carrier, 'other', [{ n: 9, quote: 'b', why: 'issue: other' }])
    await fixture.saveConflicts(carrier, 'net-gpt', [{ n: 8, quote: 'c', why: 'issue: moved' }])
    assert.deepEqual((await rows()).map(r => [r.bot_name, r.peer_n]), [['net-gpt', 8], ['other', 9]])
    assert.deepEqual(carrier.conflicts.map(c => [c.bot, c.n]), [['other', 9], ['net-gpt', 8]])

    // The clear path is the table's whole contract: a review that finds nothing
    // has to erase what the last one found.
    await fixture.saveConflicts(carrier, 'net-gpt', [])
    assert.deepEqual((await rows()).map(r => [r.bot_name, r.peer_n]), [['other', 9]])

    const attached = [{ id: spec.id }, { id: 'no-rows' }]
    await fixture.attachConflicts(attached)
    assert.deepEqual(attached[0].conflicts.map(c => c.n), [9])
    assert.deepEqual(attached[1].conflicts, [], 'a spec with no findings carries an empty list, never undefined')

    // Sweeping: a bot that no longer covers the namespace, and a spec that left
    // review, both leave rows no later review would replace.
    await db.query("INSERT INTO spec_board_reviews (note_id, bot_name, reviewed_hash) VALUES ($1,'other','v3:kept')", [spec.id])
    const inReview = { id: spec.id, statusIdx: api.specsFromRows([{ id, shortid: 'note-one', content: text, permission: 'editable' }])[0].statusIdx, namespace: 'team/specs' }
    await fixture.dropStaleConflicts([inReview], [{ name: 'other', namespaces: ['team/specs'] }])
    assert.equal((await rows()).length, 1, 'a covered spec under review keeps its findings')
    await fixture.dropStaleConflicts([inReview], [{ name: 'other', namespaces: ['elsewhere/specs'] }])
    assert.equal((await rows()).length, 0, 'a bot dropped from the namespace loses its findings')
    assert.equal((await fixture.loadReviews()).size, 0, 'the fingerprint goes too, so a later review can rebuild them')

    await fixture.saveConflicts(carrier, 'other', [{ n: 9, quote: 'b', why: 'issue: other' }])
    await fixture.dropStaleConflicts([{ ...inReview, statusIdx: 3 }], [{ name: 'other', namespaces: ['team/specs'] }])
    assert.equal((await rows()).length, 0, 'a spec past review loses its findings')

    console.log('audit database integration tests passed')
  } finally {
    if (db) await db.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
