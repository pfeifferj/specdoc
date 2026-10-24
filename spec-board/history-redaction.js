'use strict'

const { createHash } = require('node:crypto')
const { assertNoCredentials } = require('./sensitive-content')
const hash = value => createHash('sha256').update(value || '').digest('hex')

async function migrateRedaction (db) {
  await db.query('ALTER TABLE spec_board_snapshot_bodies ADD COLUMN IF NOT EXISTS redacted_at timestamptz')
  await db.query('ALTER TABLE spec_board_publication_intents ADD COLUMN IF NOT EXISTS redacted_at timestamptz')
}

function noteIds (ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 128 || ids.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) {
    throw new Error('Choose 1–128 exact note IDs')
  }
  return [...new Set(ids)].sort()
}

async function planRedaction (db, requested) {
  const ids = noteIds(requested)
  const { rows: notes } = await db.query('SELECT id,shortid,content FROM "Notes" WHERE shortid=ANY($1) ORDER BY shortid', [ids])
  if (notes.length !== ids.length) throw new Error('Every requested note must exist; no changes were made')
  const { rows: bodies } = await db.query('SELECT DISTINCT hash FROM spec_board_snapshots WHERE note_id=ANY($1) ORDER BY hash', [ids])
  const hashes = bodies.map(row => row.hash)
  const { rows: shared } = await db.query('SELECT DISTINCT note_id FROM spec_board_snapshots WHERE hash=ANY($1) AND NOT note_id=ANY($2) ORDER BY note_id', [hashes, ids])
  const { rows: intents } = await db.query('SELECT id,note_id,candidate_hash,document_hash FROM spec_board_publication_intents WHERE note_id=ANY($1) ORDER BY note_id,id', [ids])
  const { rows: artifacts } = await db.query(`SELECT id,action,evidence->>'messageHash' AS message_hash,evidence->>'documentHash' AS document_hash
    FROM spec_board_governance_events WHERE action IN ('checkpoint-authorized','map-authorized')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(evidence->'sources')='array'
        THEN evidence->'sources' ELSE '[]'::jsonb END) source WHERE source->>'noteId'=ANY($1)) ORDER BY id`, [ids])
  const { rows: counts } = await db.query(`SELECT
    (SELECT count(*)::int FROM "Revisions" WHERE "noteId"=ANY($1::uuid[])) AS revisions,
    (SELECT count(*)::int FROM spec_board_notifications WHERE note_id=ANY($2)) AS notifications,
    (SELECT count(*)::int FROM spec_board_conflicts WHERE note_id=ANY($2)) AS conflicts,
    (SELECT count(*)::int FROM spec_board_feedback_proposals WHERE target_note=ANY($2)) AS feedback_proposals`, [notes.map(n => n.id), ids])
  const { rows: jobs } = await db.query('SELECT DISTINCT job_id FROM spec_board_feedback_proposals WHERE target_note=ANY($1) ORDER BY job_id', [ids])
  return {
    notes: notes.map(note => ({ id: note.shortid, uuid: note.id, currentContentHash: hash(note.content) })),
    snapshotHashes: hashes, sharedWith: shared.map(row => row.note_id), publicationIntents: intents, derivedArtifacts: artifacts,
    ...counts[0], feedbackJobs: jobs.map(row => row.job_id),
    retained: 'Current text, immutable IDs, hashes, approvals, relations and audit records. Notes become private and hidden.',
    externalCopies: 'Published Git history, delivered mail, external model/provider records, logs and backups require separate remediation.'
  }
}

async function assertOwner (db) {
  const names = ['"Notes"', '"Revisions"', 'spec_board_snapshot_bodies', 'spec_board_publication_intents', 'spec_board_governance_events']
  const { rows } = await db.query(`SELECT name FROM unnest($1::text[]) name LEFT JOIN pg_class c ON c.oid=to_regclass(name)
    WHERE c.oid IS NULL OR NOT pg_has_role(current_user,c.relowner,'USAGE')`, [names])
  if (rows.length) throw new Error('History redaction requires an offline database owner credential for both editor and board tables')
}

async function redactHistory (pool, options) {
  const ids = noteIds(options.notes)
  if (options.offline !== true) throw new Error('Stop the board and editor, then acknowledge offline maintenance with --offline')
  if (!/^[1-9]\d{0,19}$/.test(options.actor || '')) throw new Error('A numeric GitHub actor ID is required')
  if (typeof options.reason !== 'string' || options.reason.trim().length < 5 || options.reason.length > 1000) throw new Error('A 5–1000 character reason is required')
  assertNoCredentials(options.reason)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout='5s'")
    await assertOwner(client)
    await client.query('SELECT pg_advisory_xact_lock($1)', [0x53504543])
    await client.query("SELECT pg_advisory_xact_lock(hashtext('specdoc-moderation'))")
    await client.query('LOCK TABLE "Notes","Revisions",spec_board_snapshots,spec_board_snapshot_bodies,spec_board_publication_intents,spec_board_governance_events IN ACCESS EXCLUSIVE MODE')
    const plan = await planRedaction(client, ids)
    if (plan.sharedWith.length) throw new Error(`Snapshot bodies are shared with other notes; include those exact IDs in the plan: ${plan.sharedWith.join(', ')}`)
    for (const note of plan.notes) {
      if (options.expectedHashes?.[note.id] !== note.currentContentHash) throw new Error(`Current text changed or its expected hash is missing for ${note.id}; prepare a new dry run`)
    }
    const { rows: current } = await client.query('SELECT content FROM "Notes" WHERE shortid=ANY($1)', [ids])
    for (const note of current) assertNoCredentials(note.content)
    const uuids = plan.notes.map(note => note.uuid)
    await client.query('UPDATE "Notes" SET permission=\'private\',"savedAt"=NULL WHERE id=ANY($1::uuid[])', [uuids])
    await client.query('DELETE FROM "Revisions" WHERE "noteId"=ANY($1::uuid[])', [uuids])
    await client.query('UPDATE spec_board_snapshot_bodies SET body=\'\',redacted_at=COALESCE(redacted_at,now()) WHERE hash=ANY($1)', [plan.snapshotHashes])
    await client.query('ALTER TABLE spec_board_publication_intents DISABLE TRIGGER specdoc_immutable_publication')
    await client.query(`UPDATE spec_board_publication_intents SET document='',candidate='{"redacted":true}'::jsonb,
      spec=jsonb_build_object('id',note_id,'namespace',namespace,'redacted',true),redacted_at=COALESCE(redacted_at,now()) WHERE note_id=ANY($1)`, [ids])
    await client.query('ALTER TABLE spec_board_publication_intents ENABLE TRIGGER specdoc_immutable_publication')
    await client.query(`UPDATE spec_board_governance_events SET evidence=(evidence - ARRAY['message','document']) ||
      jsonb_build_object('redacted',true,'redactedAt',COALESCE(evidence->'redactedAt',to_jsonb(now())))
      WHERE id=ANY($1::bigint[])`, [plan.derivedArtifacts.map(row => row.id)])
    await client.query('DELETE FROM spec_board_conflicts WHERE note_id=ANY($1)', [ids])
    await client.query('DELETE FROM spec_board_notifications WHERE note_id=ANY($1)', [ids])
    await client.query('UPDATE spec_board_operations SET prepared=NULL,result=NULL,expired=true WHERE note_id=ANY($1)', [ids])
    await client.query(`UPDATE spec_board_feedback_proposals SET payload=NULL,stale=true,status='stale',version=version+1,changed_at=now()
      WHERE target_note=ANY($1)`, [ids])
    await client.query('UPDATE spec_board_feedback_runs SET payload=NULL WHERE job_id=ANY($1::bigint[])', [plan.feedbackJobs])
    const editorReceipts = (await client.query('SELECT to_regclass(\'"PublicOperations"\') IS NOT NULL AS present')).rows[0].present
    if (editorReceipts) await client.query('UPDATE "PublicOperations" SET result=NULL WHERE "noteId"=ANY($1::uuid[])', [uuids])
    for (const note of plan.notes) {
      await client.query(`INSERT INTO spec_board_moderation_notes(note_id,state,actor,reason) VALUES($1,'hidden',$2,$3)
        ON CONFLICT(note_id) DO UPDATE SET state='hidden',actor=EXCLUDED.actor,reason=EXCLUDED.reason,changed_at=now()`, [note.id, options.actor, options.reason.trim()])
      await client.query(`INSERT INTO spec_board_moderation_events(actor,action,target,reason) VALUES($1,'history-redacted',$2,$3)`, [options.actor, note.id, options.reason.trim()])
      const evidence = { reason: options.reason.trim(), currentContentHash: note.currentContentHash,
        snapshotHashes: plan.snapshotHashes, publicationIntents: plan.publicationIntents.filter(intent => intent.note_id === note.id),
        derivedArtifacts: plan.derivedArtifacts, feedbackJobs: plan.feedbackJobs }
      await client.query(`INSERT INTO spec_board_governance_events(note_id,actor,action,evidence,body_hash)
        VALUES($1,$2,'history-redacted',$3,$4)`, [note.id, `github:${options.actor}`, JSON.stringify(evidence), note.currentContentHash])
    }
    await client.query('COMMIT')
    return { applied: true, ...plan }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

module.exports = { migrateRedaction, planRedaction, redactHistory }
