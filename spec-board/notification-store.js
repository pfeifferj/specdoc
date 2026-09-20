const { event } = require('./notifications')

async function migrateNotifications (db) {
  await db.query('ALTER TABLE spec_board_notifications ADD COLUMN IF NOT EXISTS event jsonb')
  await db.query('ALTER TABLE spec_board_notifications ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz')
  await db.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS discussion_hashes jsonb')
  await db.query('CREATE INDEX IF NOT EXISTS spec_board_notifications_recipient ON spec_board_notifications (email, created_at, id)')
}

async function dueRecipients (db, debounceMinutes, limit = 8) {
  const { rows } = await db.query(
    `SELECT email FROM spec_board_notifications GROUP BY email
     HAVING (max(created_at) < now() - ($1 * interval '1 minute')
             OR min(created_at) < now() - ($1 * 8 * interval '1 minute'))
       AND (max(last_attempt_at) IS NULL
            OR max(last_attempt_at) < now() - ($1 * interval '1 minute'))
     ORDER BY COALESCE(max(last_attempt_at), min(created_at)), min(created_at), email LIMIT $2`,
    [debounceMinutes, Math.max(1, Math.min(100, limit))])
  return rows
}

async function notificationQueueStatus (db) {
  const { rows: [row] } = await db.query(`SELECT count(*)::integer AS queued,
    count(DISTINCT email)::integer AS recipients,
    count(*) FILTER (WHERE attempts > 0)::integer AS failing,
    min(created_at) AS oldest_at FROM spec_board_notifications`)
  return { queued: row.queued, recipients: row.recipients, failing: row.failing,
    oldestAt: row.oldest_at ? new Date(row.oldest_at).toISOString() : null }
}

async function visibleNotifications (db, rows) {
  if (!rows.length) return []
  const { rows: visible } = await db.query(
    `SELECT shortid FROM "Notes" WHERE shortid = ANY($1::text[])
     AND (permission IS NULL OR permission IN ('freely', 'editable', 'locked'))`,
    [[...new Set(rows.map(r => r.note_id))]])
  const ids = new Set(visible.map(r => r.shortid))
  return rows.filter(r => ids.has(r.note_id))
}

async function insertNotifications (db, spec, events, recipients) {
  const pairs = recipients.flatMap(recipient => events.map(value => ({
    email: recipient.email,
    event: { ...(typeof value === 'string' ? event('activity', value, { url: spec.url, namespace: spec.namespace }) : value), reasons: recipient.reasons }
  })))
  if (!pairs.length) return
  await db.query(
    `INSERT INTO spec_board_notifications (email, note_id, title, line, event)
     SELECT p.email, $1, $2, p.line, p.event::jsonb
     FROM unnest($3::text[], $4::text[], $5::text[]) AS p(email, line, event)`,
    [spec.id, spec.title, pairs.map(p => p.email), pairs.map(p => p.event.line), pairs.map(p => JSON.stringify(p.event))])
}

module.exports = { migrateNotifications, visibleNotifications, insertNotifications, dueRecipients, notificationQueueStatus }
