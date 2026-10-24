const { esc } = require('./prosediff')
const { authorized } = require('./security-identities')

const fail = (status, message) => Object.assign(new Error(message), { status })
const subject = who => who?.provider === 'github' && /^[1-9]\d{0,19}$/.test(who.subject || '') ? who.subject : null

async function migrateModeration (db) {
  await db.query(`CREATE TABLE IF NOT EXISTS spec_board_moderation_notes (
    note_id text PRIMARY KEY, state text NOT NULL CHECK (state IN ('hidden','visible')),
    actor text NOT NULL, reason text NOT NULL, changed_at timestamptz NOT NULL DEFAULT now())`)
  await db.query(`CREATE TABLE IF NOT EXISTS spec_board_moderation_accounts (
    provider text NOT NULL, subject text NOT NULL, state text NOT NULL CHECK (state IN ('suspended','active')),
    actor text NOT NULL, reason text NOT NULL, changed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(provider,subject))`)
  await db.query(`CREATE TABLE IF NOT EXISTS spec_board_moderation_uploads (
    filename text PRIMARY KEY, state text NOT NULL CHECK (state IN ('hidden','visible')),
    actor text NOT NULL, reason text NOT NULL, changed_at timestamptz NOT NULL DEFAULT now())`)
  await db.query(`CREATE TABLE IF NOT EXISTS spec_board_moderation_reports (
    id bigserial PRIMARY KEY, note_id text NOT NULL, reporter text NOT NULL, owner_subject text,
    category text NOT NULL, reason text NOT NULL, state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
    created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz)`)
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS spec_board_report_open ON spec_board_moderation_reports(note_id,reporter) WHERE state='open'`)
  await db.query(`CREATE TABLE IF NOT EXISTS spec_board_moderation_events (
    id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, target text NOT NULL,
    reason text NOT NULL, previous jsonb, created_at timestamptz NOT NULL DEFAULT now())`)
  await db.query(`CREATE TABLE IF NOT EXISTS spec_board_moderation_budget (
    scope text NOT NULL, day date NOT NULL DEFAULT CURRENT_DATE, total integer NOT NULL DEFAULT 0, PRIMARY KEY(scope,day))`)
}

async function assertModerationAllowed (db, spec) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('specdoc-moderation'))")
  const { rows } = await db.query(`SELECT 1 FROM spec_board_moderation_notes WHERE note_id=$1 AND state='hidden'
    UNION ALL SELECT 1 FROM spec_board_moderation_accounts WHERE provider='github' AND subject=$2 AND state='suspended'`,
  [spec.id, spec.ownerSubject || null])
  if (rows.length) throw fail(403, 'Content or account is restricted by moderation')
}

async function assertAutomationContext (db, ids) {
  const unique = [...new Set(ids)]
  if (!unique.length) return
  const { rows } = await db.query(`SELECT n.shortid FROM "Notes" n LEFT JOIN "Users" u ON u.id=n."ownerId"
    WHERE n.shortid=ANY($1::text[]) AND (n.permission IS NULL OR n.permission IN ('freely','editable','locked'))
      AND NOT EXISTS (SELECT 1 FROM spec_board_moderation_notes m WHERE m.note_id=n.shortid AND m.state='hidden')
      AND NOT EXISTS (SELECT 1 FROM spec_board_moderation_accounts a WHERE a.state='suspended' AND a.provider='github'
        AND u.profile::jsonb->>'provider'='github' AND u.profile::jsonb->>'id'=a.subject
        AND u.profileid IN (a.subject,'github:' || a.subject))`, [unique])
  if (rows.length !== unique.length) throw fail(403, 'Review context is no longer public or is restricted by moderation')
}

async function expireReports (db) {
  await db.query(`DELETE FROM spec_board_moderation_reports WHERE id IN
    (SELECT id FROM spec_board_moderation_reports WHERE state='closed' AND closed_at < now() - interval '90 days' ORDER BY id LIMIT 1000)`)
}

async function transaction (pool, fn) {
  const db = await pool.connect()
  try {
    await db.query('BEGIN')
    await db.query("SELECT pg_advisory_xact_lock(hashtext('specdoc-moderation'))")
    const value = await fn(db)
    await db.query('COMMIT')
    return value
  } catch (error) { await db.query('ROLLBACK'); throw error } finally { db.release() }
}

async function reportContent (pool, who, spec, category, reason) {
  const id = subject(who)
  if (!id) throw fail(401, 'Sign in to report content')
  if (!['spam', 'harassment', 'sensitive-data', 'other'].includes(category)) throw fail(400, 'Choose a report category')
  if (typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 1000) throw fail(400, 'Report reason must be 5–1000 characters')
  return transaction(pool, async db => {
    await assertModerationAllowed(db, { id: spec.id, ownerSubject: id })
    const duplicate = await db.query("SELECT id FROM spec_board_moderation_reports WHERE note_id=$1 AND reporter=$2 AND state='open'", [spec.id, id])
    if (duplicate.rows.length) return duplicate.rows[0].id
    const count = await db.query("SELECT count(*)::integer AS n FROM spec_board_moderation_reports WHERE state='open'")
    if (count.rows[0].n >= 1000) throw fail(429, 'The report queue is full; use the contact address on the privacy page')
    await db.query('DELETE FROM spec_board_moderation_budget WHERE day < CURRENT_DATE - 7')
    for (const [scope, limit] of [['*', 200], [id, 5]]) {
      await db.query('INSERT INTO spec_board_moderation_budget(scope) VALUES ($1) ON CONFLICT DO NOTHING', [scope])
      const result = await db.query(`UPDATE spec_board_moderation_budget SET total=total+1
        WHERE scope=$1 AND day=CURRENT_DATE AND total < $2 RETURNING total`, [scope, limit])
      if (!result.rowCount) throw fail(429, 'Daily report limit reached')
    }
    const result = await db.query(`INSERT INTO spec_board_moderation_reports(note_id,reporter,owner_subject,category,reason)
      VALUES($1,$2,$3,$4,$5) RETURNING id`, [spec.id, id, spec.ownerSubject || null, category, reason.trim()])
    return result.rows[0].id
  })
}

async function moderate (pool, who, action, target, reason) {
  const id = subject(who)
  if (!id) throw fail(401, 'A stable moderator identity is required')
  if (!['hide', 'restore', 'suspend', 'unsuspend', 'block-upload', 'restore-upload', 'close-report'].includes(action)) throw fail(400, 'Unknown moderation action')
  if (typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 1000) throw fail(400, 'Decision reason must be 5–1000 characters')
  const account = ['suspend', 'unsuspend'].includes(action)
  const upload = ['block-upload', 'restore-upload'].includes(action)
  const targetPattern = upload ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/ : account || action === 'close-report' ? /^[1-9]\d{0,19}$/ : /^[\w-]{1,128}$/
  if (!targetPattern.test(target || '')) throw fail(400, 'Invalid moderation target')
  if (account && target === id) throw fail(400, 'Moderators cannot suspend their own account')
  return transaction(pool, async db => {
    let previous = null
    if (upload) {
      previous = (await db.query('SELECT * FROM spec_board_moderation_uploads WHERE filename=$1', [target])).rows[0] || null
      await db.query(`INSERT INTO spec_board_moderation_uploads(filename,state,actor,reason) VALUES($1,$2,$3,$4)
        ON CONFLICT(filename) DO UPDATE SET state=EXCLUDED.state,actor=EXCLUDED.actor,reason=EXCLUDED.reason,changed_at=now()`,
      [target, action === 'block-upload' ? 'hidden' : 'visible', id, reason.trim()])
    } else if (account) {
      previous = (await db.query("SELECT * FROM spec_board_moderation_accounts WHERE provider='github' AND subject=$1", [target])).rows[0] || null
      await db.query(`INSERT INTO spec_board_moderation_accounts(provider,subject,state,actor,reason) VALUES('github',$1,$2,$3,$4)
        ON CONFLICT(provider,subject) DO UPDATE SET state=EXCLUDED.state,actor=EXCLUDED.actor,reason=EXCLUDED.reason,changed_at=now()`,
      [target, action === 'suspend' ? 'suspended' : 'active', id, reason.trim()])
    } else if (action === 'close-report') {
      previous = (await db.query('SELECT id,note_id,state FROM spec_board_moderation_reports WHERE id=$1', [target])).rows[0]
      if (!previous) throw fail(404, 'Report not found')
      await db.query("UPDATE spec_board_moderation_reports SET state='closed',closed_at=now() WHERE id=$1", [target])
    } else {
      previous = (await db.query('SELECT * FROM spec_board_moderation_notes WHERE note_id=$1', [target])).rows[0] || null
      await db.query(`INSERT INTO spec_board_moderation_notes(note_id,state,actor,reason) VALUES($1,$2,$3,$4)
        ON CONFLICT(note_id) DO UPDATE SET state=EXCLUDED.state,actor=EXCLUDED.actor,reason=EXCLUDED.reason,changed_at=now()`,
      [target, action === 'hide' ? 'hidden' : 'visible', id, reason.trim()])
    }
    await db.query('INSERT INTO spec_board_moderation_events(actor,action,target,reason,previous) VALUES($1,$2,$3,$4,$5)',
      [id, action, target, reason.trim(), JSON.stringify(previous)])
  })
}

function createModerationService ({ pool, session, csrfToken, isAdmin, readBody, startLogin, basicPage, visibleSpecs }) {
  const moderators = (process.env.BOARD_MODERATOR_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
  const canModerate = who => isAdmin(who) || (authorized(who, moderators) && Number.isFinite(who.authenticatedAt) && Date.now() - who.authenticatedAt < 3600000)
  const send = (res, status, title, body, who) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(basicPage(title, body, { page: 'moderation', who }))
  }
  const field = value => esc(String(value || ''))
  const decisionForm = (who, target = '', action = 'hide') => `<form method="post" action="/moderation">
    <input type="hidden" name="csrf" value="${field(csrfToken(who))}">
    <label>Action <select name="action">${['hide','restore','suspend','unsuspend','block-upload','restore-upload','close-report'].map(a => `<option${a === action ? ' selected' : ''}>${a}</option>`).join('')}</select></label>
    <label>Note ID, GitHub account ID, upload filename, or report ID <input name="target" required value="${field(target)}"></label>
    <label>Reason <textarea name="reason" minlength="5" maxlength="1000" required></textarea></label><button>Record decision</button></form>`

  async function handle (req, res, url) {
    const who = session(req)
    if (!subject(who)) { startLogin(req, res, url.pathname + url.search); return }
    try {
      await assertModerationAllowed(pool, { id: '', ownerSubject: who.subject })
      if (url.pathname === '/moderation/report') {
        const id = url.searchParams.get('note') || ''
        const spec = (await visibleSpecs()).find(spec => spec.id === id)
        if (!spec) throw fail(404, 'Note is not publicly available')
        if (req.method === 'GET') {
          send(res, 200, 'Report content', `<h1>Report ${field(spec.title)}</h1><p>Reports are reviewed by a moderator. A report does not automatically hide content.</p>
            <form method="post"><input type="hidden" name="csrf" value="${field(csrfToken(who))}">
            <label>Category <select name="category"><option>spam</option><option>harassment</option><option>sensitive-data</option><option>other</option></select></label>
            <label>Reason <textarea name="reason" minlength="5" maxlength="1000" required></textarea></label><button>Submit report</button></form>`, who)
          return
        }
        if (req.method !== 'POST') throw fail(405, 'Method not allowed')
        const form = new URLSearchParams(await readBody(req))
        if (form.get('csrf') !== csrfToken(who)) throw fail(403, 'Invalid CSRF token')
        await reportContent(pool, who, spec, form.get('category'), form.get('reason'))
        send(res, 200, 'Report received', '<h1>Report received</h1><p>A moderator will review it. Repeated reports of the same note are combined.</p>', who)
        return
      }
      if (!canModerate(who)) throw fail(403, 'Moderator access required')
      if (req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req))
        if (form.get('csrf') !== csrfToken(who)) throw fail(403, 'Invalid CSRF token')
        await moderate(pool, who, form.get('action'), form.get('target'), form.get('reason'))
        res.writeHead(303, { Location: '/moderation', 'Cache-Control': 'no-store' }); res.end(); return
      }
      if (req.method !== 'GET') throw fail(405, 'Method not allowed')
      const { rows } = await pool.query("SELECT * FROM spec_board_moderation_reports WHERE state='open' ORDER BY id LIMIT 100")
      const { rows: decisions } = await pool.query('SELECT * FROM spec_board_moderation_events ORDER BY id DESC LIMIT 100')
      const reports = rows.map(r => `<li><b>Report ${field(r.id)}</b> · ${field(r.category)} · note ${field(r.note_id)} · owner GitHub ID ${field(r.owner_subject)}
        <p>${field(r.reason)}</p>${decisionForm(who, r.note_id)}</li>`).join('')
      const history = decisions.map(r => `<li>${field(r.action)} ${field(r.target)} by GitHub ID ${field(r.actor)}: ${field(r.reason)}</li>`).join('')
      send(res, 200, 'Moderation', `<h1>Moderation</h1><p>Hide removes a note from public editor and board access. Suspend blocks account writes and automation. Block-upload withdraws a local attachment by its filename, such as the final part of an /uploads/ URL. Hiding a note does not automatically withdraw its attachments. Restore actions preserve the decision history.</p>
        <h2>Open reports</h2><ul>${reports || '<li>No open reports.</li>'}</ul><h2>Record a decision</h2>${decisionForm(who)}<h2>Recent decisions</h2><ul>${history}</ul>`, who)
    } catch (error) { send(res, error.status || 500, 'Moderation', `<h1>Moderation</h1><p>${field(error.status ? error.message : 'Could not complete the request')}</p>`, who) }
  }
  return { handle, canModerate }
}

module.exports = { migrateModeration, assertModerationAllowed, assertAutomationContext, expireReports, reportContent, moderate, createModerationService }
