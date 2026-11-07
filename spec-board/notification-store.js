const { event } = require('./notifications')
const { permittedContext } = require('./moderation')
const crypto = require('crypto')
const retentionMinutes = debounceMinutes => Math.max(7 * 24 * 60, 9 * debounceMinutes)

async function migrateNotifications (db) {
  await db.query('ALTER TABLE spec_board_notifications ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0')
  await db.query('ALTER TABLE spec_board_notifications ADD COLUMN IF NOT EXISTS event jsonb')
  await db.query('ALTER TABLE spec_board_notifications ADD COLUMN IF NOT EXISTS address_verified boolean NOT NULL DEFAULT false')
  await db.query('ALTER TABLE spec_board_notifications ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz')
  await db.query('ALTER TABLE spec_board_notifications ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz')
  await db.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS discussion_hashes jsonb')
  await db.query('CREATE INDEX IF NOT EXISTS spec_board_notifications_recipient ON spec_board_notifications (email, created_at, id)')
  await db.query("ALTER TABLE spec_board_notifications ADD COLUMN IF NOT EXISTS namespace text NOT NULL DEFAULT ''")
  await db.query('ALTER TABLE spec_board_notifications ADD COLUMN IF NOT EXISTS dedup_key text')
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS spec_board_notifications_dedup ON spec_board_notifications (dedup_key) WHERE dedup_key IS NOT NULL')
  await db.query(`CREATE TABLE IF NOT EXISTS spec_board_notification_budget (
    scope text NOT NULL, day date NOT NULL DEFAULT CURRENT_DATE, total integer NOT NULL DEFAULT 0, PRIMARY KEY (scope, day))`)
  await db.query(`CREATE OR REPLACE FUNCTION spec_board_enqueue_notifications(note text, project text, title_text text, items jsonb)
    RETURNS integer LANGUAGE plpgsql AS $$
    DECLARE item jsonb; inserted integer := 0; counted integer; used integer; recipient text;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('specdoc-notification-cap'));
      DELETE FROM spec_board_notification_budget WHERE day < CURRENT_DATE - 7;
      INSERT INTO spec_board_notification_budget(scope) VALUES ('*') ON CONFLICT DO NOTHING;
      FOR item IN SELECT value FROM jsonb_array_elements(items) LIMIT 1000 LOOP
        recipient := item->>'email';
        SELECT total INTO used FROM spec_board_notification_budget WHERE scope='*' AND day=CURRENT_DATE;
        EXIT WHEN used >= 20000;
        EXIT WHEN (SELECT count(*) FROM spec_board_notifications) >= 20000;
        EXIT WHEN (SELECT count(*) FROM spec_board_notifications WHERE namespace=project) >= 2000;
        EXIT WHEN (SELECT count(*) FROM spec_board_notifications WHERE note_id=note) >= 1000;
        IF (SELECT count(*) FROM spec_board_notifications WHERE email=recipient) >= 200 THEN CONTINUE; END IF;
        INSERT INTO spec_board_notification_budget(scope) VALUES (recipient) ON CONFLICT DO NOTHING;
        SELECT total INTO used FROM spec_board_notification_budget WHERE scope=recipient AND day=CURRENT_DATE;
        IF used >= 200 THEN CONTINUE; END IF;
        INSERT INTO spec_board_notifications(email,note_id,title,line,event,namespace,dedup_key,address_verified)
          VALUES(recipient,note,left(title_text,500),left(item->'event'->>'line',2000),item->'event',project,item->>'key',true)
          ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING;
        GET DIAGNOSTICS counted = ROW_COUNT;
        IF counted > 0 THEN
          UPDATE spec_board_notification_budget SET total=total+1 WHERE scope IN ('*',recipient) AND day=CURRENT_DATE;
          inserted := inserted + 1;
        END IF;
      END LOOP;
      RETURN inserted;
    END $$`)
}

async function dueRecipients (db, debounceMinutes, limit = 8) {
  const { rows } = await db.query(
    `SELECT email FROM spec_board_notifications
     WHERE address_verified AND attempts < 20 AND created_at >= now() - ($3 * interval '1 minute')
       AND (next_attempt_at IS NULL OR next_attempt_at <= now())
     GROUP BY email
     HAVING (max(created_at) < now() - ($1 * interval '1 minute')
             OR min(created_at) < now() - ($1 * 8 * interval '1 minute'))
       AND (max(last_attempt_at) IS NULL
            OR max(last_attempt_at) < now() - ($1 * interval '1 minute'))
     ORDER BY COALESCE(max(last_attempt_at), min(created_at)), min(created_at), email LIMIT $2`,
    [debounceMinutes, Math.max(1, Math.min(100, limit)), retentionMinutes(debounceMinutes)])
  return rows
}

async function notificationQueueStatus (db) {
  const { rows: [row] } = await db.query(`SELECT count(*)::integer AS queued,
    count(DISTINCT email)::integer AS recipients,
    count(*) FILTER (WHERE attempts > 0 OR event->>'reviewPolicyUnavailable'='true')::integer AS failing,
    count(*) FILTER (WHERE next_attempt_at IS NOT NULL)::integer AS deferred,
    min(created_at) AS oldest_at FROM spec_board_notifications`)
  return { queued: row.queued, recipients: row.recipients, failing: row.failing, deferred: row.deferred,
    oldestAt: row.oldest_at ? new Date(row.oldest_at).toISOString() : null }
}

async function visibleNotifications (db, rows) {
  const permitted = await permittedContext(db, rows.map(r => r.note_id))
  const subjects = [...new Set(rows.map(row => row.event?.actorSubject).filter(subject => /^[1-9]\d{0,19}$/.test(subject || '')))]
  const suspended = subjects.length ? new Set((await db.query(`SELECT subject FROM spec_board_moderation_accounts
    WHERE provider='github' AND state='suspended' AND subject=ANY($1::text[])`, [subjects])).rows.map(row => row.subject)) : new Set()
  return rows.filter(r => permitted.has(r.note_id) && !suspended.has(r.event?.actorSubject))
}

async function insertNotifications (db, spec, events, recipients) {
  if (process.env.NOTIFICATIONS_PAUSED === 'true') return
  const hour = new Date().toISOString().slice(0, 13)
  const pairs = recipients.slice(0, 100).flatMap(recipient => events.slice(0, 10).map(value => ({
    email: recipient.email,
    event: { ...(typeof value === 'string' ? event('activity', value, { url: spec.url, namespace: spec.namespace }) : value), reasons: recipient.reasons }
  })))
  if (!pairs.length) return
  for (const pair of pairs) {
    pair.event.line = String(pair.event.line || '').slice(0, 2000)
    const identity = [hour, spec.id, pair.email, pair.event.kind, pair.event.line]
    if (pair.event.eventId) identity.push(pair.event.eventId)
    pair.key = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  }
  await db.query('SELECT spec_board_enqueue_notifications($1,$2,$3,$4::jsonb)',
    [spec.id, spec.namespace || '', spec.title, JSON.stringify(pairs)])
}

module.exports = { migrateNotifications, visibleNotifications, insertNotifications, dueRecipients, notificationQueueStatus, retentionMinutes }
