'use strict'

const SCHEMA_VERSION = 3
const identifier = value => {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) throw new Error('Database role and schema names must be simple PostgreSQL identifiers')
  return '"' + value + '"'
}

async function location (db) {
  const { rows: [row] } = await db.query(`SELECT current_schema() AS board,
    (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass('"Notes"')) AS editor`)
  if (!row?.board || !row.editor) throw new Error('The board search_path must include its own schema followed by the editor schema')
  identifier(row.board)
  identifier(row.editor)
  return row
}

async function assertMigrationTarget (db) {
  const { board } = await location(db)
  const { rows: [existing] } = await db.query(`SELECT n.nspname AS schema FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass('spec_board_state')`)
  if (existing && existing.schema !== board) throw new Error(`Existing board tables are in ${existing.schema}; move them to ${board} before migrating. No new empty state was created.`)
}

async function installEditorFunctions (db) {
  const { board, editor } = await location(db)
  const b = identifier(board), e = identifier(editor)
  await db.query(`CREATE OR REPLACE FUNCTION ${b}.specdoc_lock_note(note_id text, exclusive boolean DEFAULT false)
    RETURNS SETOF ${e}."Notes" LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    BEGIN
      IF exclusive THEN
        RETURN QUERY SELECT n.* FROM ${e}."Notes" n WHERE n.shortid=note_id FOR UPDATE;
      ELSE
        RETURN QUERY SELECT n.* FROM ${e}."Notes" n WHERE n.shortid=note_id FOR SHARE;
      END IF;
    END $$`)
  await db.query(`CREATE OR REPLACE FUNCTION ${b}.specdoc_lock_user(user_id text)
    RETURNS TABLE(id text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
      SELECT u.id::text FROM ${e}."Users" u WHERE u.id::text=user_id FOR SHARE
    $$`)
  await db.query(`CREATE OR REPLACE FUNCTION ${b}.specdoc_set_verified_emails(user_id text, subject text, emails jsonb)
    RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    DECLARE changed integer;
    BEGIN
      IF subject !~ '^[1-9][0-9]{0,19}$' OR jsonb_typeof(emails) IS DISTINCT FROM 'array'
        OR jsonb_array_length(emails)>20 THEN RAISE EXCEPTION 'Invalid verified email update'; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(emails) x WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'
        OR x->'verified' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(x->'primary') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(x->'value') IS DISTINCT FROM 'string' OR length(x->>'value')>254
        OR x->>'value' !~ '^[^[:space:]@]+@[^[:space:]@]+$'
        OR EXISTS (SELECT 1 FROM jsonb_object_keys(x) k WHERE k NOT IN ('value','verified','primary')))
        THEN RAISE EXCEPTION 'Invalid verified email entry'; END IF;
      UPDATE ${e}."Users" SET profile=jsonb_set(profile::jsonb,'{emails}',emails)::text
        WHERE id::text=user_id AND profile::jsonb->>'provider'='github' AND profile::jsonb->>'id'=subject;
      GET DIAGNOSTICS changed=ROW_COUNT;
      RETURN changed;
    END $$`)
  for (const signature of ['specdoc_lock_note(text,boolean)', 'specdoc_lock_user(text)', 'specdoc_set_verified_emails(text,text,jsonb)']) {
    await db.query(`REVOKE ALL ON FUNCTION ${b}.${signature} FROM PUBLIC`)
  }
}

async function grantRuntime (db, role, { editorRole = process.env.EDITOR_DB_ROLE } = {}) {
  const { board, editor } = await location(db)
  if (board === editor) throw new Error('Runtime privilege separation requires different board and editor schemas')
  const r = identifier(role), b = identifier(board), e = identifier(editor)
  const { rows: [runtime] } = await db.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=$1', [role])
  if (!runtime || Object.values(runtime).some(Boolean)) throw new Error('The board runtime role must exist without administrative privileges')
  await db.query(`REVOKE ALL ON SCHEMA ${b} FROM PUBLIC`)
  await db.query(`GRANT USAGE ON SCHEMA ${b},${e} TO ${r}`)
  await db.query(`REVOKE CREATE ON SCHEMA ${b} FROM ${r}`)
  const { rows: tables } = await db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND c.relname LIKE 'spec_board_%'`, [board])
  const appendOnly = new Set(['spec_board_governance_events', 'spec_board_planning_events', 'spec_board_feedback_decisions', 'spec_board_moderation_events'])
  for (const { relname } of tables) {
    const name = `${b}.${identifier(relname)}`
    await db.query(`REVOKE ALL ON TABLE ${name} FROM PUBLIC,${r}`)
    const privileges = relname === 'spec_board_schema' ? 'SELECT' : appendOnly.has(relname) ? 'SELECT,INSERT' :
      relname === 'spec_board_publication_intents' ? 'SELECT,INSERT,UPDATE' : relname === 'spec_board_snapshot_bodies' ? 'SELECT,INSERT,DELETE' : 'SELECT,INSERT,UPDATE,DELETE'
    await db.query(`GRANT ${privileges} ON TABLE ${name} TO ${r}`)
    if (relname === 'spec_board_snapshot_bodies') await db.query(`GRANT UPDATE(hash) ON TABLE ${name} TO ${r}`)
  }
  await db.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${b} TO ${r}`)
  await db.query(`GRANT SELECT ON TABLE ${e}."Notes",${e}."Authors" TO ${r}`)
  await db.query(`GRANT SELECT(id,profile,profileid,email) ON TABLE ${e}."Users" TO ${r}`)
  for (const signature of ['specdoc_lock_note(text,boolean)', 'specdoc_lock_user(text)', 'specdoc_set_verified_emails(text,text,jsonb)', 'specdoc_purge_feedback_reasons()']) {
    await db.query(`GRANT EXECUTE ON FUNCTION ${b}.${signature} TO ${r}`)
  }
  if (editorRole) {
    const er = identifier(editorRole)
    await db.query(`GRANT USAGE ON SCHEMA ${b} TO ${er}`)
    await db.query(`GRANT SELECT ON ${b}.spec_board_moderation_notes,${b}.spec_board_moderation_accounts,${b}.spec_board_moderation_uploads TO ${er}`)
  }
}

async function installFeedbackRetention (db) {
  const { rows: [{ board }] } = await db.query('SELECT current_schema() AS board')
  const b = identifier(board)
  await db.query(`CREATE OR REPLACE FUNCTION ${b}.specdoc_purge_feedback_reasons()
    RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    DECLARE changed integer;
    BEGIN
      UPDATE ${b}.spec_board_feedback_decisions d SET extra=d.extra - 'reason'
        WHERE pg_catalog.jsonb_typeof(d.extra)='object' AND d.extra ? 'reason'
          AND d.created_at < pg_catalog.now() - interval '90 days'
          AND EXISTS (SELECT 1 FROM ${b}.spec_board_feedback_proposals p
            WHERE p.id=d.proposal_id AND p.status IN ('dismissed','incorporated')
              AND p.decided_at < pg_catalog.now() - interval '90 days');
      GET DIAGNOSTICS changed=ROW_COUNT;
      RETURN changed;
    END $$;
    REVOKE ALL ON FUNCTION ${b}.specdoc_purge_feedback_reasons() FROM PUBLIC;`)
}

async function recordSchema (db) {
  await db.query(`CREATE TABLE IF NOT EXISTS spec_board_schema (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL,
    migrated_at timestamptz NOT NULL DEFAULT now())`)
  await db.query(`INSERT INTO spec_board_schema(singleton,version) VALUES(true,$1)
    ON CONFLICT(singleton) DO UPDATE SET version=EXCLUDED.version,migrated_at=now()`, [SCHEMA_VERSION])
}

async function verifyRuntime (db, { allowMigrationRole = false } = {}) {
  const { rows: [schema] } = await db.query('SELECT version FROM spec_board_schema WHERE singleton')
  if (schema?.version !== SCHEMA_VERSION) throw new Error(`Database schema is incompatible; run node server.js --migrate for schema ${SCHEMA_VERSION}`)
  for (const name of ['spec_board_publication_intents', 'spec_board_governance_events', 'spec_board_moderation_notes', 'spec_board_moderation_accounts', 'spec_board_moderation_uploads',
    'spec_board_review_threads', 'spec_board_review_messages', 'spec_board_review_events', 'spec_board_review_requests', 'spec_board_review_reminders']) {
    const { rows: [row] } = await db.query('SELECT to_regclass($1) IS NOT NULL AS present', [name])
    if (!row?.present) throw new Error(`Database schema is missing ${name}; rerun the migration job`)
  }
  for (const name of ['spec_board_publication_intents', 'spec_board_snapshot_bodies']) {
    const { rows: [row] } = await db.query(`SELECT EXISTS (SELECT 1 FROM pg_attribute
      WHERE attrelid=to_regclass($1) AND attname='redacted_at' AND NOT attisdropped) AS present`, [name])
    if (!row?.present) throw new Error(`Database schema is missing ${name}.redacted_at; rerun the migration job`)
  }
  const { rows: [notificationSchema] } = await db.query(`SELECT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid='spec_board_notifications'::regclass AND attname='address_verified' AND NOT attisdropped) AS present`)
  if (!notificationSchema?.present) throw new Error('Database schema is missing verified notification eligibility; rerun the migration job')
  if (!allowMigrationRole) {
    const { rows: [role] } = await db.query(`SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user`)
    const { rows: unsafeSchemas } = await db.query(`SELECT n FROM unnest(current_schemas(false)) n WHERE has_schema_privilege(current_user,n,'CREATE')`)
    const { rows: [grants] } = await db.query(`SELECT
      has_any_column_privilege(current_user,'"Notes"','UPDATE') AS note_update,
      has_any_column_privilege(current_user,'"Users"','UPDATE') AS user_update,
      has_table_privilege(current_user,'"Users"','TRIGGER') AS user_trigger,
      has_column_privilege(current_user,'"Users"','accessToken','SELECT') AS oauth_read,
      has_table_privilege(current_user,'spec_board_governance_events','UPDATE,DELETE,TRUNCATE') AS audit_mutation,
      has_any_column_privilege(current_user,'spec_board_feedback_decisions','UPDATE') AS feedback_update,
      has_table_privilege(current_user,'spec_board_feedback_decisions','DELETE,TRUNCATE,TRIGGER') AS feedback_mutation`)
    if (!role || Object.values(role).some(Boolean) || unsafeSchemas.length || Object.values(grants).some(Boolean)) {
      throw new Error('Board runtime database privileges are excessive; use the restricted role provisioned by the migration job')
    }
  }
  for (const signature of ['specdoc_lock_note(text,boolean)', 'specdoc_lock_user(text)', 'specdoc_set_verified_emails(text,text,jsonb)', 'specdoc_purge_feedback_reasons()']) {
    const { rows: [row] } = await db.query('SELECT has_function_privilege(current_user,$1,\'EXECUTE\') AS allowed', [signature])
    if (!row?.allowed) throw new Error(`Board runtime cannot call ${signature}`)
  }
}

module.exports = { SCHEMA_VERSION, identifier, assertMigrationTarget, installEditorFunctions, installFeedbackRetention, grantRuntime, recordSchema, verifyRuntime }
