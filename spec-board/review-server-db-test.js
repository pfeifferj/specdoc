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
  const initialRoles = 'approvers: [approver, fresh-reviewer]\napprovals-required: 1\n'
  let roleDocument = initialRoles
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
      content: Buffer.from(roleDocument).toString('base64')
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
    for (const [document, expected] of [
      ["approvers: approver, fresh-reviewer\napprovals-required: '2'\n", { approvers: ['approver', 'fresh-reviewer'], required: 2 }],
      ['approvers: [approver]\napprovals-required: 7\n', { approvers: ['approver'], required: 1 }],
      ['approvers: [approver]\napprovals-required: bad\n', { approvers: ['approver'], required: 1 }]
    ]) {
      roleDocument = document
      const review = await pendingReviewSource('proposal', db, { refreshPolicy: true })
      assert.equal(review.policyKnown, true, 'existing governing-policy syntax remains usable for discussion reminders')
      assert.deepEqual({ approvers: review.approvers, required: review.required }, expected)
    }
    roleDocument = initialRoles
    await pendingReviewSource('proposal', db, { refreshPolicy: true })
    const visitor = { provider: 'github', subject: '303', login: 'visitor' }
    const visitorAuthorization = { namespace: current.namespace, subject: visitor.subject, approver: false }
    assert.equal(await server.authorizeReview({ actor: visitor, action: 'thread', source: current, authorization: visitorAuthorization }), true)
    for (const sealed of [{ ...current, permission: 'locked' }, { ...current, status: 'approved' }]) {
      await assert.rejects(server.authorizeReview({ actor: visitor, action: 'thread', source: sealed, authorization: visitorAuthorization }), { status: 403, code: 'review-sealed' },
        'an unrelated participant cannot add blockers to a locked or approved spec')
      assert.equal(await server.authorizeReview({ actor: { ...visitor, subject: '101' }, action: 'thread', source: sealed }), true)
    }
    const resolvedThread = { starter: visitor, resolved: true, resolvedBy: { subject: '201' } }
    assert.equal(await server.authorizeReview({ actor: visitor, action: 'reopen', source: current,
      thread: resolvedThread, authorization: visitorAuthorization }), false, 'a starter cannot reverse another resolver')
    resolvedThread.resolvedBy = visitor
    assert.equal(await server.authorizeReview({ actor: visitor, action: 'reopen', source: current,
      thread: resolvedThread, authorization: visitorAuthorization }), true)
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
    const participants = createReviewService({ store,
      loadSource: (id, client = db, options) => reviewCurrentSource(id, client, options),
      prepareAuthorize: async ({ actor }) => ({ namespace: 'team/specs', subject: actor.subject, approver: false }),
      authorize: server.authorizeReview })
    const startRequest = { body: 'Can the transition be retried?', requestId: crypto.randomUUID() }
    const started = await participants.act('proposal', visitor, 'thread', startRequest)
    const resolved = await participants.act('proposal', visitor, 'resolve', {
      threadId: started.threadId, version: started.version, requestId: crypto.randomUUID() })
    const reopenRequest = { threadId: started.threadId, version: resolved.version, requestId: crypto.randomUUID() }
    const reopened = await participants.act('proposal', visitor, 'reopen', reopenRequest)
    const replayed = await participants.act('proposal', visitor, 'reopen', reopenRequest)
    assert.equal(replayed.replayed, true, 'a starter can recover the receipt after reopening cleared resolvedBy')
    assert.equal(replayed.eventId, reopened.eventId)
    await db.query("UPDATE \"Notes\" SET permission='locked' WHERE shortid='proposal'")
    assert.equal((await participants.act('proposal', visitor, 'thread', startRequest)).eventId, started.eventId,
      'locking a note cannot hide a previously completed thread request from its actor')
    await assert.rejects(participants.act('proposal', visitor, 'thread', { ...startRequest, requestId: crypto.randomUUID() }), { status: 403, code: 'review-sealed' })
    await participants.act('proposal', { provider: 'github', subject: '101', login: 'real-owner' }, 'resolve', {
      threadId: started.threadId, version: reopened.version, requestId: crypto.randomUUID() })
    await db.query("UPDATE \"Notes\" SET permission='editable' WHERE shortid='proposal'")
    await db.query(`INSERT INTO spec_board_snapshots (note_id,kind,label,hash,taken_at) VALUES
      ('proposal','approval','approver',$1,now()-interval '2 minutes'),
      ('proposal','status','approved',$1,now()-interval '1 minute')`, [publishedHash(current.body)])
    await db.query('UPDATE "Notes" SET permission=\'private\',content=$1 WHERE shortid=\'proposal\'',
      [content.replace('ready-for-review', 'draft')])
    assert.equal(await source(), null, 'private notes remain unavailable to public review reads')
    const round = await db.connect()
    try {
      await round.query('BEGIN')
      assert.equal(await server.endApprovalRound('proposal', {}, round), 1)
      await round.query('COMMIT')
    } finally { round.release() }
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM spec_board_snapshots WHERE kind='approval'")).rows[0].n, 0,
      'a private note leaving approved loses the previous round approvals')
    assert.equal((await store.read('proposal')).activity.at(-1).action, 'approval-round-ended')
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
