const assert = require('assert/strict')
const crypto = require('crypto')
const { Pool } = require('pg')
const { createReviewStore } = require('./review-store')
const { createReviewService } = require('./review-service')

const connectionString = process.env.REVIEW_TEST_DATABASE_URL
if (!connectionString) { console.error('Set REVIEW_TEST_DATABASE_URL to an explicit PostgreSQL test database.'); process.exit(1) }

async function main () {
  const schema = 'review_server_test_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  const originalFetch = global.fetch
  let db
  let roleFetches = 0
  process.env.NAMESPACES = 'team/specs'
  process.env.DEFAULT_NAMESPACE = 'team/specs'
  process.env.GITHUB_TOKEN = 'review-server-fixture'
  process.env.GITHUB_APP_ID = ''
  process.env.SMTP_HOST = ''
  process.env.WEBHOOK_URL = ''
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.github.com/repos/team/specs/contents/.specs/roles.yml', 'only the fixture roles lookup may request a URL')
    assert.equal(options.method, 'GET')
    roleFetches++
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({
      content: Buffer.from('approvers: [approver, fresh-reviewer]\napprovals-required: 1\n').toString('base64')
    }) }
  }
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 })
    await db.query('CREATE TABLE "Users" (id text PRIMARY KEY, profile text, profileid text, email text)')
    await db.query(`CREATE TABLE "Notes" (id text, shortid text PRIMARY KEY, alias text,
      title text, content text, authorship text, permission text, "lastchangeAt" timestamptz DEFAULT now(),
      "ownerId" text, "lastchangeuserId" text)`)
    await db.query(`CREATE TABLE spec_board_state (note_id text PRIMARY KEY, namespace text,
      pr_number integer, pr_state text, category text, spec_path text, published_hash text,
      published_commit text, revision integer, revision_pr integer, publication_generation bigint DEFAULT 0,
      implemented_at timestamptz, superseded_at timestamptz)`)
    await db.query(`CREATE TABLE spec_board_snapshots (id bigserial PRIMARY KEY, note_id text, kind text,
      label text, hash text, notified_hash text, taken_at timestamptz DEFAULT now())`)
    await db.query('CREATE TABLE spec_board_subscriptions (user_id text, namespace text, level text)')
    await db.query('CREATE TABLE spec_board_notify_email (user_id text, namespace text, email text)')
    await db.query('CREATE TABLE spec_board_optout (email_hash text PRIMARY KEY)')
    const user = async (id, subject, login, provider = 'github', profileid = `github:${subject}`, email = `${login}@example.test`) => {
      await db.query('INSERT INTO "Users" VALUES ($1,$2,$3,$4)', [id,
        JSON.stringify({ provider, id: subject, username: login, displayName: login, emails: [{ value: email, verified: true }] }), profileid, email])
    }
    await user('owner', '101', 'real-owner')
    await user('approver', '201', 'approver')
    await user('fresh', '202', 'fresh-reviewer')
    await user('collision', '202', 'fresh-reviewer', 'google', '202', 'collision@example.test')
    await user('mismatch', '202', 'fresh-reviewer', 'github', 'github:999', 'mismatch@example.test')
    const content = '---\ntags: [spec, ready-for-review]\nnamespace: team/specs\nowner: impostor\napproved-by: [impostor]\n---\n\n# Requirements\n\nThe checkpoint remains available.\n'
    await db.query(`INSERT INTO "Notes" (id, shortid, title, content, permission, "ownerId", "lastchangeuserId")
      VALUES ($1,'proposal','Checkpoint behavior',$2,'editable','owner','owner')`, [crypto.randomUUID(), content])
    await db.query("INSERT INTO spec_board_state(note_id,namespace) VALUES ('proposal','team/specs')")
    const store = createReviewStore(db)
    await store.migrate()
    const server = require('./server')
    for (const name of ['reviewCurrentSource', 'pendingReviewRecipients', 'reviewRecord', 'pendingReviewSource']) {
      assert.equal(typeof server[name], 'function', `server must export ${name} for the independent wiring fixture`)
    }
    const { reviewCurrentSource, pendingReviewRecipients, reviewRecord, pendingReviewSource, canApprove, publishedHash } = server
    const source = () => reviewCurrentSource('proposal', db)
    let current = await source()
    assert.equal(current.ownerSubject, '101')
    assert.equal(current.ownerLogin, 'real-owner', 'editable owner frontmatter cannot choose the proposer')
    assert.equal((await reviewRecord(current, 0, db)).approvedBy.length, 0, 'frontmatter is not recorded approval activity')
    assert.equal((await store.read('proposal')).activity.length, 0, 'existing snapshots are not invented as historical events')
    await db.query('UPDATE "Users" SET profileid=\'github:999\' WHERE id=\'owner\'')
    assert.equal((await source()).ownerSubject, null)
    await db.query('UPDATE "Users" SET profileid=\'github:101\', profile=$1 WHERE id=\'owner\'',
      [JSON.stringify({ provider: 'local', id: '101', username: 'real-owner' })])
    assert.equal((await source()).ownerSubject, null, 'profile provider and stored provider identity must both agree')
    await db.query('UPDATE "Users" SET profile=$1 WHERE id=\'owner\'',
      [JSON.stringify({ provider: 'github', id: '101', username: 'real-owner' })])
    for (const permission of ['private', 'limited', 'protected']) {
      await db.query('UPDATE "Notes" SET permission=$1 WHERE shortid=\'proposal\'', [permission])
      assert.equal(await source(), null)
    }
    await db.query('UPDATE "Notes" SET permission=\'locked\' WHERE shortid=\'proposal\'')
    assert.equal((await source()).permission, 'locked', 'locked public notes stay readable')
    await db.query('UPDATE "Notes" SET content=\'An ordinary note.\' WHERE shortid=\'proposal\'')
    assert.equal(await source(), null)
    await db.query('UPDATE "Notes" SET content=$1,permission=\'editable\' WHERE shortid=\'proposal\'', [content])
    const moved = content.replace('namespace: team/specs', 'namespace: another/specs')
    await db.query('UPDATE "Notes" SET content=$1 WHERE shortid=\'proposal\'', [moved])
    assert.equal(await source(), null, 'an unconfigured namespace cannot expose review actions')
    await db.query("UPDATE spec_board_state SET pr_number=42,pr_state='merged' WHERE note_id='proposal'")
    assert.equal((await source()).namespace, 'team/specs', 'publication pins the namespace despite edited frontmatter')
    await db.query('UPDATE "Notes" SET content=$1 WHERE shortid=\'proposal\'', [content])
    current = await source()
    await db.query(`INSERT INTO spec_board_snapshots (note_id,kind,label,hash)
      VALUES ('proposal','approval','approver',$1)`, [publishedHash(current.body)])
    await pendingReviewSource('proposal', db)
    assert.equal((await reviewRecord(current, 0, db)).approvals, 1)
    assert.equal(canApprove(current.spec), true)
    const service = createReviewService({ store, loadSource: (id, client = db, options) => reviewCurrentSource(id, client, options),
      authorize: async () => true })
    const actor = { provider: 'github', subject: '201', login: 'approver' }
    const thread = await service.act('proposal', actor, 'thread', { body: 'How does recovery work?', requestId: crypto.randomUUID() })
    current = await source()
    const blocked = await reviewRecord(current, await store.openCount('proposal'), db)
    assert.equal(blocked.openDiscussions, 1)
    assert.equal(canApprove(current.spec), false, 'a fresh general-discussion count blocks publication despite quorum')
    await service.act('proposal', actor, 'resolve', { threadId: thread.threadId, version: thread.version, requestId: crypto.randomUUID() })
    current = await source()
    await reviewRecord(current, 0, db)
    assert.equal(canApprove(current.spec), true)
    let pending = await pendingReviewSource('proposal', db)
    assert.deepEqual(pending.approved, ['approver'])
    await db.query('UPDATE "Notes" SET content=$1 WHERE shortid=\'proposal\'', [content.replace('remains available', 'expires after recovery')])
    pending = await pendingReviewSource('proposal', db)
    assert.deepEqual(pending.approved, [], 'old approval text cannot suppress a new review reminder')
    const oldApprovalHash = publishedHash(current.body)
    const event = { noteId: 'proposal', actor: { subject: '201', login: 'approver' }, action: 'retract', requestId: 'approval-token-fixture' }
    const withdrawal = await db.connect()
    try {
      await withdrawal.query('BEGIN')
      await withdrawal.query('SELECT 1 FROM "Notes" WHERE shortid=\'proposal\' FOR UPDATE')
      await server.retractApprovalRecord(withdrawal, event)
      await withdrawal.query('COMMIT')
    } finally { withdrawal.release() }
    const history = (await store.read('proposal')).activity
    assert.equal(history.at(-1).action, 'retract')
    assert.equal(history.at(-1).bodyHash, oldApprovalHash, 'withdrawal identifies the reviewed text, not the later edit')
    assert.notEqual(history.at(-1).bodyHash, publishedHash(pending.body))
    assert.ok(roleFetches > 0)
    let addresses = await pendingReviewRecipients(pending, 'fresh-reviewer', db)
    assert.deepEqual(addresses.map(row => row.email), ['fresh-reviewer@example.test'],
      'a configured approver needs no previous participation, and provider collisions do not add recipients')
    await db.query("INSERT INTO spec_board_subscriptions VALUES ('fresh','team/specs','disabled')")
    assert.deepEqual(await pendingReviewRecipients(pending, 'fresh-reviewer', db), [])
    await db.query('DELETE FROM spec_board_subscriptions')
    await db.query("INSERT INTO spec_board_notify_email VALUES ('fresh','','default@example.test'),('fresh','team/specs','project@example.test')")
    addresses = await pendingReviewRecipients(pending, 'fresh-reviewer', db)
    assert.deepEqual(addresses.map(row => row.email), ['project@example.test'])
    await db.query('INSERT INTO spec_board_optout VALUES ($1)', [crypto.createHash('sha256').update('project@example.test').digest('hex')])
    assert.deepEqual(await pendingReviewRecipients(pending, 'fresh-reviewer', db), [])
    await db.query('DELETE FROM "Notes" WHERE shortid=\'proposal\'')
    assert.equal(await source(), null)
    console.log('review server database tests passed')
  } finally {
    global.fetch = originalFetch
    if (db) await db.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
