const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { Pool } = require('pg')
const intents = require('./publication-intent')
const { digest } = require('./publication-candidate')
const { installEditorFunctions } = require('./database-admin')
const { migrateModeration, moderate } = require('./moderation')

const connectionString = process.env.AUDIT_TEST_DATABASE_URL
if (!connectionString) { console.error('Set AUDIT_TEST_DATABASE_URL to a disposable PostgreSQL database.'); process.exit(1) }

async function main () {
  const schema = 'publication_security_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  const oldFetch = global.fetch
  let db, server
  const roles = { approvers: [{ id: '42', login: 'reviewer' }], authors: ['10'], 'approvals-required': 1 }
  const text = '---\ntags: [spec, approved]\nnamespace: team/specs\nsupersedes: 7\n---\nReviewed requirement.\n'
  const note = { id: crypto.randomUUID(), shortid: 'note', title: 'Requirement', content: text, permission: 'editable',
    owner_id: crypto.randomUUID(), owner_profileid: 'github:10', owner_profile: JSON.stringify({ provider: 'github', id: '10', username: 'writer' }) }
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(connectionString)
    Object.assign(process.env, { PGHOST: url.hostname, PGPORT: url.port, PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: url.pathname.slice(1), PGOPTIONS: `-c search_path=${schema}`,
      GITHUB_TOKEN: 'publication-fixture-token', NAMESPACES: 'team/specs,other/specs', BOARD_ADMIN_IDS: '99', HEDGEDOC_BASE_URL: 'https://editor.test' })
    delete process.env.GITHUB_APP_ID
    delete process.env.GITHUB_APP_PRIVATE_KEY
    db = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 })
    await db.query('CREATE TABLE "Users" (id uuid PRIMARY KEY, profile text, profileid text, email text)')
    await db.query('CREATE TABLE "Notes" (id uuid PRIMARY KEY, shortid text UNIQUE, title text, content text, permission text, alias text, authorship text, "lastchangeAt" timestamptz, "ownerId" uuid)')
    await db.query(`CREATE TABLE spec_board_state(note_id text PRIMARY KEY, namespace text, pr_number integer, pr_state text,
      category text,spec_path text,published_hash text,published_commit text,revision integer,revision_pr integer,
      publication_generation bigint NOT NULL DEFAULT 0,superseded_at timestamptz,implemented_at timestamptz)`)
    await db.query('CREATE TABLE spec_board_snapshot_bodies(hash text PRIMARY KEY,body text NOT NULL)')
    await db.query(`CREATE TABLE spec_board_snapshots(id serial PRIMARY KEY,note_id text NOT NULL,kind text NOT NULL,label text NOT NULL,
      hash text NOT NULL REFERENCES spec_board_snapshot_bodies(hash),notified_hash text,taken_at timestamptz DEFAULT now())`)
    await db.query("CREATE UNIQUE INDEX spec_board_snapshots_one ON spec_board_snapshots(note_id,kind,lower(label)) WHERE kind <> 'status'")
    await intents.migrate(db)
    await migrateModeration(db)
    await installEditorFunctions(db)
    await db.query('INSERT INTO "Users" VALUES ($1,$2,$3,$4)', [note.owner_id, note.owner_profile, note.owner_profileid, 'writer@example.test'])
    await db.query('INSERT INTO "Notes"(id,shortid,title,content,permission,"ownerId") VALUES ($1,$2,$3,$4,$5,$6)', [note.id, note.shortid, note.title, note.content, note.permission, note.owner_id])
    await db.query("INSERT INTO spec_board_state(note_id,namespace) VALUES ('note','team/specs')")
    global.fetch = async url => {
      assert.equal(String(url), 'https://api.github.com/repos/team/specs/contents/.specs/roles.yml')
      return new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(roles)).toString('base64') }), { status: 200 })
    }
    const file = path.join(__dirname, 'server.js')
    const mod = new Module(file + '.publication-security-test', module)
    mod.filename = file
    mod.paths = Module._nodeModulePaths(__dirname)
    mod._compile(fs.readFileSync(file, 'utf8') + '\ncommitIdentities=async()=>({author:null,reviewers:[]}); module.exports.fixture={pool,authorizePublication,authorizeCheckpoint,authorizeMap,noteApprovalPost};\n', file)
    server = mod.exports
    const spec = () => server.applyRoles(server.specsFromRows([note])[0], { ...roles, 'specs-dir': 'specs' })
    const approve = async s => {
      const receipt = { provider: 'github', subject: '42', candidate_hash: s.candidate.hash, policy_hash: s.candidate.policy }
      await server.withTx(client => server.takeSnapshot(s.id, 'approval', 'reviewer', server.publishedBody(s), digest(server.publishedBody(s)), client, { receipt }), db)
      s.approvalReceipts = (await server.loadNoteSnapshots(s.id, db)).filter(r => r.kind === 'approval')
      server.countApprovals(s)
      return s
    }
    const readState = async () => (await db.query("SELECT * FROM spec_board_state WHERE note_id='note'")).rows[0]
    const authorize = async s => server.fixture.authorizePublication(s, await readState())
    const original = await approve(spec())
    const claim = await authorize(original)
    assert.equal(claim.intent.candidate_hash, original.candidate.hash)
    assert.ok(claim.intent.document.endsWith('Reviewed requirement.\n'))
    const retry = await authorize(original)
    assert.equal(retry.intent.id, claim.intent.id, 'same candidate resumes its durable submission')
    assert.notEqual(retry.generation, claim.generation)
    await assert.rejects(db.query("UPDATE spec_board_publication_intents SET document='tampered' WHERE id=$1", [claim.intent.id]), /immutable/)

    await db.query('UPDATE "Notes" SET content=$1', [text + 'Owner edit after authorization.'])
    assert.equal((await db.query('SELECT document FROM spec_board_publication_intents WHERE id=$1', [claim.intent.id])).rows[0].document, claim.intent.document)
    await assert.rejects(authorize(original), /changed before publication/)
    await db.query('UPDATE "Notes" SET content=$1', [text])
    await db.query("DELETE FROM spec_board_snapshots WHERE kind='approval'")
    await assert.rejects(authorize(original), /quorum/)
    await approve(original)

    for (const permission of ['private', 'protected', 'limited']) {
      await db.query('UPDATE "Notes" SET permission=$1', [permission])
      await assert.rejects(authorize(original), /quorum/)
    }
    await db.query("UPDATE \"Notes\" SET permission='editable'")
    roles.approvers = [{ id: '43', login: 'reviewer' }]
    await assert.rejects(authorize(original), /quorum/)
    roles.approvers = [{ id: '42', login: 'reviewer' }]

    const blocker = await db.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query("SELECT * FROM \"Notes\" WHERE shortid='note' FOR UPDATE")
      await blocker.query("DELETE FROM spec_board_snapshots WHERE kind='approval'")
      const pending = authorize(original).then(value => ({ value }), error => ({ error }))
      await new Promise(resolve => setTimeout(resolve, 40))
      await blocker.query('COMMIT')
      assert.match((await pending).error.message, /quorum/, 'a retraction committed while claim waits is observed')
    } finally { await blocker.query('ROLLBACK'); blocker.release() }
    await approve(original)

    await moderate(db, { provider: 'github', subject: '99' }, 'hide', 'note', 'Reported sensitive material')
    await assert.rejects(authorize(original), { status: 403 })
    await moderate(db, { provider: 'github', subject: '99' }, 'restore', 'note', 'Reviewed and allowed')
    await moderate(db, { provider: 'github', subject: '99' }, 'suspend', '10', 'Automated posting abuse')
    await assert.rejects(authorize(original), { status: 403 })
    await moderate(db, { provider: 'github', subject: '99' }, 'unsuspend', '10', 'Account recovered safely')
    await moderate(db, { provider: 'github', subject: '99' }, 'suspend', '42', 'Approval abuse under investigation')
    await assert.rejects(authorize(original), /quorum/, 'suspended approvers cannot authorize another publication')
    await moderate(db, { provider: 'github', subject: '99' }, 'unsuspend', '42', 'Approval investigation complete')

    await db.query("UPDATE spec_board_publication_intents SET path='specs/008-requirement.md',base_sha=$2,base_branch='main',pr_number=8 WHERE id=$1", [claim.intent.id, 'a'.repeat(40)])
    const recovered = { number: 8, namespace: 'team/specs', base: 'main', path: 'specs/008-requirement.md', state: 'merged', commit: 'b'.repeat(40), body: claim.intent.document }
    assert.equal(await intents.verifiedReceipt(db, { ...recovered, number: 9 }, 'team/specs', 'note'), null)
    assert.equal(await intents.verifiedReceipt(db, { ...recovered, body: recovered.body + 'edit' }, 'team/specs', 'note'), null)
    const verified = await intents.verifiedReceipt(db, recovered, 'team/specs', 'note')
    assert.equal(verified.submission, claim.intent.id)
    await db.query("INSERT INTO spec_board_state(note_id,namespace,pr_number) VALUES ('old','team/specs',7),('other','other/specs',7)")
    const tx = fn => server.withTx(fn, db)
    assert.equal(await tx(client => intents.retire(client, 'other', verified)), false)
    await db.query("UPDATE spec_board_state SET superseded_at='2020-01-01T00:00:00Z' WHERE note_id='old'")
    assert.equal(await tx(client => intents.retire(client, 'old', verified)), true)
    assert.equal((await db.query("SELECT evidence->>'previousAt' AS previous FROM spec_board_governance_events WHERE note_id='old' AND action='superseded'")).rows[0].previous, '2020-01-01T00:00:00.000Z')
    assert.equal(await tx(client => intents.unretire(client, 'old', '99', 'The replacement was merged in error')), true)
    assert.equal(await tx(client => intents.retire(client, 'old', verified)), false, 'polling cannot undo a recorded reversal')
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM spec_board_governance_events WHERE note_id='old'")).rows[0].n, 2)

    const cp = { ns: 'team/specs', next: 'specs/v1', head: 'b'.repeat(40), sources: [original],
      graph: [{ id: 'note', ns: 'team/specs', n: 8, area: '', title: 'Requirement' }], overlap: null, changes: null, summary: null }
    const actor = { provider: 'github', subject: '99', authenticatedAt: Date.now() }
    const checkpoint = await server.fixture.authorizeCheckpoint(cp, actor)
    assert.match(checkpoint.message, /Requirement/)
    const map = await server.fixture.authorizeMap('team/specs', [original], { path: 'specs/README.md', branch: 'map-claim', head: cp.head }, actor, { spec: original, number: 8 })
    assert.match(map.document, /Requirement/)
    assert.equal(map.documentHash, digest(map.document))
    await assert.rejects(server.fixture.authorizeCheckpoint(cp, { ...actor, subject: '42' }), /administrator/)
    await db.query("UPDATE \"Notes\" SET permission='private'")
    await assert.rejects(server.fixture.authorizeCheckpoint(cp, actor), /visibility changed/)
    await assert.rejects(server.fixture.authorizeMap('team/specs', [original], { path: map.path, branch: map.branch, head: cp.head }, actor), /visibility changed/)
    await db.query("UPDATE \"Notes\" SET permission='editable',content=$1", [text + 'Later change.'])
    await assert.rejects(server.fixture.authorizeCheckpoint(cp, actor), /source or admission changed/)
    const savedCheckpoint = (await db.query("SELECT evidence FROM spec_board_governance_events WHERE action='checkpoint-authorized'")).rows[0].evidence
    assert.equal(savedCheckpoint.message, checkpoint.message, 'post-authorization edits cannot replace the durable tag manifest')
    assert.equal((await db.query("SELECT evidence->>'document' AS document FROM spec_board_governance_events WHERE action='map-authorized'")).rows[0].document, map.document)
    await db.query('UPDATE "Notes" SET content=$1', [text])
    roles.authors = []
    await assert.rejects(server.fixture.authorizeCheckpoint(cp, actor), /source or admission changed/)
    roles.authors = ['10']
    await moderate(db, actor, 'hide', 'note', 'Hidden before checkpoint authorization')
    await assert.rejects(server.fixture.authorizeCheckpoint(cp, actor), { status: 403 })
    await moderate(db, actor, 'restore', 'note', 'Checkpoint source reviewed')

    await db.query("UPDATE spec_board_state SET pr_number=8 WHERE note_id='note'")
    await db.query('DELETE FROM "Notes"')
    await intents.collectSnapshots(db)
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM spec_board_snapshots WHERE note_id='note'")).rows[0].n, 1)
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM spec_board_snapshot_bodies')).rows[0].n, 1)
    console.log('publication security database: immutable claims, retraction races, confidentiality, moderation, verified retirement, reversal and checkpoint manifests passed')
  } finally {
    global.fetch = oldFetch
    if (server) await server.fixture.pool.end()
    if (db) await db.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
