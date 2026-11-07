'use strict'

const crypto = require('crypto')
const { canonical, digest, publicationDocument, receiptMatches } = require('./publication-candidate')

async function migrate (db) {
  for (const [name, type] of [['candidate_hash', 'text'], ['policy_hash', 'text'], ['provider', 'text'], ['subject', 'text']]) {
    await db.query(`ALTER TABLE spec_board_snapshots ADD COLUMN IF NOT EXISTS ${name} ${type}`)
  }
  for (const [name, type] of [['published_candidate_hash', 'text'], ['supersession_receipt', 'jsonb'], ['publication_receipt', 'jsonb']]) {
    await db.query(`ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS ${name} ${type}`)
  }
  await db.query(`CREATE TABLE IF NOT EXISTS spec_board_publication_intents (
    id uuid PRIMARY KEY, note_id text NOT NULL, namespace text NOT NULL,
    candidate_hash text NOT NULL, policy_hash text NOT NULL, revision integer NOT NULL,
    candidate jsonb NOT NULL, approvals jsonb NOT NULL, relations jsonb NOT NULL,
    document text NOT NULL, document_hash text NOT NULL, spec jsonb NOT NULL,
    identities jsonb NOT NULL, path text, branch text NOT NULL, base_sha text, base_branch text, redacted_at timestamptz,
    pr_number integer, merged_commit text, created_at timestamptz NOT NULL DEFAULT now()
  )`)
  await db.query(`CREATE TABLE IF NOT EXISTS spec_board_governance_events (
    id bigserial PRIMARY KEY, note_id text NOT NULL, actor text NOT NULL,
    action text NOT NULL, evidence jsonb NOT NULL, body_hash text, created_at timestamptz NOT NULL DEFAULT now()
  )`)
  await db.query(`DO $$ DECLARE constraint_name text; BEGIN
    FOR constraint_name IN SELECT c.conname FROM pg_constraint c
      WHERE c.conrelid='spec_board_publication_intents'::regclass AND c.contype='u'
        AND (SELECT array_agg(a.attname::text ORDER BY k.position)
          FROM unnest(c.conkey) WITH ORDINALITY k(attribute,position)
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attribute)
          = ARRAY['note_id','candidate_hash','revision']::text[]
    LOOP EXECUTE format('ALTER TABLE spec_board_publication_intents DROP CONSTRAINT %I',constraint_name); END LOOP;
  END $$`)
  await db.query(`CREATE INDEX IF NOT EXISTS spec_board_publication_superseded ON spec_board_governance_events
    ((evidence->>'submission')) WHERE action='publication-superseded'`)
  await db.query(`CREATE INDEX IF NOT EXISTS spec_board_publication_artifacts
    ON spec_board_governance_events ((evidence->>'submission'), id DESC)
    WHERE action IN ('map-authorized','supersession-stamp-authorized')`)
  await db.query(`CREATE OR REPLACE FUNCTION specdoc_immutable_publication() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (to_jsonb(NEW) - ARRAY['path','branch','base_sha','base_branch','pr_number','merged_commit']) IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['path','branch','base_sha','base_branch','pr_number','merged_commit'])
        OR (OLD.path IS NOT NULL AND NEW.path IS DISTINCT FROM OLD.path)
        OR (OLD.path IS NOT NULL AND NEW.branch IS DISTINCT FROM OLD.branch)
        OR (OLD.base_sha IS NOT NULL AND NEW.base_sha IS DISTINCT FROM OLD.base_sha)
        OR (OLD.base_branch IS NOT NULL AND NEW.base_branch IS DISTINCT FROM OLD.base_branch)
        OR (OLD.pr_number IS NOT NULL AND NEW.pr_number IS DISTINCT FROM OLD.pr_number)
        OR (OLD.merged_commit IS NOT NULL AND NEW.merged_commit IS DISTINCT FROM OLD.merged_commit)
      THEN RAISE EXCEPTION 'Publication intent is immutable'; END IF;
      RETURN NEW;
    END $$`)
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='spec_board_publication_intents'::regclass AND tgname='specdoc_immutable_publication') THEN
      CREATE TRIGGER specdoc_immutable_publication BEFORE UPDATE ON spec_board_publication_intents FOR EACH ROW EXECUTE FUNCTION specdoc_immutable_publication();
    END IF;
  END $$`)
}

async function recordEvent (db, noteId, actor, action, evidence) {
  await db.query('INSERT INTO spec_board_governance_events(note_id,actor,action,evidence,body_hash) VALUES ($1,$2,$3,$4,$5)',
    [noteId, actor, action, JSON.stringify(evidence), evidence.bodyHash || evidence.hash || null])
}

async function createIntent (db, spec, candidate, approvals, identities, revision = 0, path = null) {
  const locked = await db.query('SELECT note_id FROM spec_board_state WHERE note_id=$1 FOR UPDATE', [spec.id])
  if (locked.rows.length !== 1) throw new Error('Publication state is required before authorizing a submission')
  const existing = await db.query(`SELECT i.* FROM spec_board_publication_intents i
    WHERE note_id=$1 AND candidate_hash=$2 AND revision=$3 AND redacted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM spec_board_governance_events e
        WHERE e.action='publication-superseded' AND e.evidence->>'submission'=i.id::text)
    ORDER BY created_at DESC LIMIT 2`, [spec.id, candidate.hash, revision])
  if (existing.rows.length > 1) throw new Error('Publication candidate has ambiguous active submissions')
  if (existing.rows.length) return existing.rows[0]
  const id = crypto.randomUUID()
  const relations = { supersedes: candidate.value.supersedes, dependsOn: candidate.value.dependsOn }
  const metadata = { format: 1, noteId: spec.id, namespace: spec.namespace, submission: id,
    candidate: candidate.hash, bodyHash: digest(spec.publicationBody), relations }
  const document = publicationDocument(spec.publicationBody, metadata)
  const branch = `specdoc/${spec.id}-${id}`
  const { rows: [intent] } = await db.query(`INSERT INTO spec_board_publication_intents
    (id,note_id,namespace,candidate_hash,policy_hash,revision,candidate,approvals,relations,document,document_hash,spec,identities,path,branch)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
  [id, spec.id, spec.namespace, candidate.hash, candidate.policy, revision, canonical(candidate.value), canonical(approvals),
    canonical(relations), document, digest(document), canonical(spec), canonical(identities), path, branch])
  if (intent.id === id) await recordEvent(db, spec.id, 'service', 'publication-authorized',
    { submission: id, candidate: candidate.hash, policy: candidate.policy, approvals })
  return intent
}

async function verifiedReceipt (db, recovered, namespace, noteId) {
  const { publicationMetadata } = require('./publication-candidate')
  const meta = publicationMetadata(recovered && recovered.body)
  if (!meta) return null
  const { rows: [intent] } = await db.query('SELECT * FROM spec_board_publication_intents WHERE id=$1', [meta.submission])
  if (!receiptMatches(recovered, intent, namespace, noteId)) return null
  await db.query('UPDATE spec_board_publication_intents SET pr_number=$2, merged_commit=$3 WHERE id=$1',
    [intent.id, recovered.number, recovered.commit])
  return { submission: intent.id, candidate: intent.candidate_hash, commit: recovered.commit,
    number: recovered.number, namespace, noteId, relations: intent.relations,
    metadata: { title: intent.candidate.title, category: intent.candidate.area, topLevel: intent.candidate.kind === 'top-level' } }
}

async function retire (db, targetId, receipt) {
  if (!receipt || !receipt.relations || !receipt.relations.supersedes || targetId === receipt.noteId) return false
  const confirmed = await db.query('SELECT relations FROM spec_board_publication_intents WHERE id=$1 AND merged_commit=$2 AND note_id=$3 AND namespace=$4 AND redacted_at IS NULL',
    [receipt.submission, receipt.commit, receipt.noteId, receipt.namespace])
  if (!confirmed.rows.length || canonical(confirmed.rows[0].relations) !== canonical(receipt.relations)) return false
  const { rows: [target] } = await db.query('SELECT * FROM spec_board_state WHERE note_id=$1 FOR UPDATE', [targetId])
  const ref = receipt.relations.supersedes
  if (!target || target.namespace !== receipt.namespace || (ref.noteId ? ref.noteId !== targetId :
    ref.ns !== receipt.namespace || ref.n !== target.pr_number)) return false
  if (target.supersession_receipt) return false
  const undone = await db.query("SELECT 1 FROM spec_board_governance_events WHERE note_id=$1 AND action='supersession-reversed' AND evidence->>'submission'=$2", [targetId, receipt.submission])
  if (undone.rows.length) return false
  await db.query('UPDATE spec_board_state SET superseded_at=now(), supersession_receipt=$2 WHERE note_id=$1', [targetId, JSON.stringify(receipt)])
  await recordEvent(db, targetId, 'service', 'superseded', { ...receipt, previousAt: target.superseded_at || null })
  return true
}

async function unretire (db, noteId, subject, reason) {
  if (!/^[1-9]\d{0,19}$/.test(subject || '') || typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 1000) throw new Error('A GitHub subject and reversal reason are required')
  const { rows: [current] } = await db.query('SELECT superseded_at, supersession_receipt FROM spec_board_state WHERE note_id=$1 FOR UPDATE', [noteId])
  if (!current || !current.superseded_at) return false
  await recordEvent(db, noteId, `github:${subject}`, 'supersession-reversed',
    { ...current.supersession_receipt, previousAt: current.superseded_at, reason: reason.trim() })
  await db.query('UPDATE spec_board_state SET superseded_at=NULL, supersession_receipt=NULL WHERE note_id=$1', [noteId])
  return true
}

async function collectSnapshots (db) {
  await db.query(`DELETE FROM spec_board_snapshots s
    WHERE NOT EXISTS (SELECT 1 FROM "Notes" n WHERE n.shortid=s.note_id)
      AND NOT EXISTS (SELECT 1 FROM spec_board_state p WHERE p.note_id=s.note_id AND (p.pr_number IS NOT NULL OR p.implemented_at IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM spec_board_publication_intents i WHERE i.note_id=s.note_id)`)
  try {
    await db.query(`DELETE FROM spec_board_snapshot_bodies b
      WHERE NOT EXISTS (SELECT 1 FROM spec_board_snapshots s WHERE s.hash=b.hash)
        AND NOT EXISTS (SELECT 1 FROM spec_board_governance_events e WHERE e.body_hash=b.hash)`)
  } catch (error) { if (error.code !== '23503') throw error }
}

module.exports = { migrate, recordEvent, createIntent, verifiedReceipt, retire, unretire, collectSnapshots }
