const crypto = require('crypto')

const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) })
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const actorOf = row => ({ subject: row.actor_subject, login: row.actor_login })
const messageOf = row => ({ id: String(row.id), body: row.body, actor: actorOf(row), createdAt: row.created_at })
const threadOf = row => ({ id: String(row.id), starter: { subject: row.starter_subject, login: row.starter_login },
  version: row.version, resolved: row.resolved, resolvedAt: row.resolved_at,
  resolvedBy: row.resolved_by_subject ? { subject: row.resolved_by_subject, login: row.resolved_by_login } : null,
  createdAt: row.created_at, updatedAt: row.updated_at })
const eventOf = row => ({ id: String(row.id), action: row.action, actor: actorOf(row),
  threadId: row.thread_id == null ? null : String(row.thread_id),
  messageId: row.message_id == null ? null : String(row.message_id),
  version: row.thread_version, bodyHash: row.body_hash, createdAt: row.created_at })

function createReviewStore (pool) {
  async function tx (task, readOnly = false) {
    const db = await pool.connect()
    try {
      await db.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
      const result = await task(db)
      await db.query('COMMIT')
      return result
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {})
      throw error
    } finally { db.release() }
  }

  async function lock (db, noteId) {
    const { rows: [row] } = await db.query(
      "SELECT pg_try_advisory_xact_lock(hashtext('specdoc-review'), hashtext($1)) AS locked", [noteId])
    if (!row.locked) throw fail(409, 'Review discussion or publication is busy. Keep your draft and try again.', 'review-busy')
  }

  async function actorLock (db, subject) {
    const { rows: [row] } = await db.query(
      "SELECT pg_try_advisory_xact_lock(hashtext('specdoc-review-actor'), hashtext($1)) AS locked", [subject])
    if (!row.locked) throw fail(409, 'Another discussion action from this account is being saved. Keep your draft and try again.', 'review-busy')
  }

  async function migrate () {
    await tx(async db => {
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_review_threads (
        id bigserial PRIMARY KEY, note_id text NOT NULL,
        starter_subject text NOT NULL, starter_login text NOT NULL,
        resolved boolean NOT NULL DEFAULT false, resolved_by_subject text, resolved_by_login text,
        resolved_at timestamptz, version integer NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (id, note_id)
      )`)
      await db.query('CREATE INDEX IF NOT EXISTS spec_board_review_threads_note ON spec_board_review_threads (note_id, id)')
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_review_messages (
        id bigserial PRIMARY KEY, note_id text NOT NULL, thread_id bigint NOT NULL,
        actor_subject text NOT NULL, actor_login text NOT NULL,
        body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (thread_id, note_id) REFERENCES spec_board_review_threads (id, note_id)
      )`)
      await db.query('CREATE INDEX IF NOT EXISTS spec_board_review_messages_thread ON spec_board_review_messages (thread_id, id)')
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_review_events (
        id bigserial PRIMARY KEY, note_id text NOT NULL, actor_subject text NOT NULL, actor_login text NOT NULL,
        action text NOT NULL CHECK (action IN ('thread', 'reply', 'resolve', 'reopen', 'approve', 'retract', 'approval-round-ended')),
        thread_id bigint, message_id bigint, thread_version integer, body_hash text,
        request_id text, created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (thread_id, note_id) REFERENCES spec_board_review_threads (id, note_id)
      )`)
      await db.query('ALTER TABLE spec_board_review_events DROP CONSTRAINT IF EXISTS spec_board_review_events_action_check')
      await db.query(`ALTER TABLE spec_board_review_events ADD CONSTRAINT spec_board_review_events_action_check
        CHECK (action IN ('thread', 'reply', 'resolve', 'reopen', 'approve', 'retract', 'approval-round-ended'))`)
      await db.query('CREATE INDEX IF NOT EXISTS spec_board_review_events_note ON spec_board_review_events (note_id, id)')
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS spec_board_review_approval_request
        ON spec_board_review_events (note_id, actor_subject, request_id)
        WHERE action IN ('approve', 'retract') AND request_id IS NOT NULL`)
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_review_requests (
        note_id text NOT NULL, actor_subject text NOT NULL, request_id text NOT NULL,
        request_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (note_id, actor_subject, request_id)
      )`)
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_review_actor_budget (
        actor_subject text PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(),
        actions integer NOT NULL CHECK (actions BETWEEN 1 AND 30)
      )`)
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_review_attempt_budget (
        actor_subject text PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(),
        attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 60)
      )`)
    })
  }

  async function status (noteId, db = pool) {
    const { rows: [row] } = await db.query(`SELECT
      (SELECT count(*)::integer FROM spec_board_review_threads WHERE note_id=$1 AND NOT resolved) AS open_count,
      (SELECT COALESCE(max(id),0)::text FROM spec_board_review_events WHERE note_id=$1) AS version`, [noteId])
    return { openDiscussions: row.open_count, version: row.version,
      fingerprint: digest(JSON.stringify([noteId, row.version, row.open_count])) }
  }

  async function openCount (noteId, db = pool) { return (await status(noteId, db)).openDiscussions }

  async function admit (actor) {
    const { rows } = await pool.query(`INSERT INTO spec_board_review_attempt_budget (actor_subject, attempts)
      VALUES ($1,1) ON CONFLICT (actor_subject) DO UPDATE SET
      started_at=CASE WHEN spec_board_review_attempt_budget.started_at <= now() - interval '1 minute'
        THEN now() ELSE spec_board_review_attempt_budget.started_at END,
      attempts=CASE WHEN spec_board_review_attempt_budget.started_at <= now() - interval '1 minute'
        THEN 1 ELSE spec_board_review_attempt_budget.attempts+1 END
      WHERE spec_board_review_attempt_budget.started_at <= now() - interval '1 minute'
        OR spec_board_review_attempt_budget.attempts < 60 RETURNING actor_subject`, [actor.subject])
    if (!rows.length) throw Object.assign(fail(429, 'Too many discussion actions. Keep your draft and try again in a minute.', 'review-rate-limit'), { retryAfter: 60 })
  }

  async function mutate ({ noteId, actor, action, payload, requestHash, validate }) {
    return tx(async db => {
      await actorLock(db, actor.subject)
      await lock(db, noteId)
      let thread = null
      if (action !== 'thread') {
        const { rows: [row] } = await db.query(
          'SELECT * FROM spec_board_review_threads WHERE note_id=$1 AND id=$2 FOR UPDATE', [noteId, payload.threadId])
        if (!row) throw fail(404, 'Unknown discussion thread.')
        thread = threadOf(row)
      }
      const { rows: [previous] } = await db.query(`SELECT request_hash, result FROM spec_board_review_requests
        WHERE note_id=$1 AND actor_subject=$2 AND request_id=$3`, [noteId, actor.subject, payload.requestId])
      await validate(db, thread, { replayed: !!previous && previous.request_hash === requestHash })
      if (previous) {
        if (previous.request_hash !== requestHash) throw fail(409, 'This request ID was already used for a different action.', 'review-replay-conflict')
        return { ...previous.result, replayed: true }
      }
      const { rows: allowance } = await db.query(`INSERT INTO spec_board_review_actor_budget (actor_subject, actions)
        VALUES ($1,1) ON CONFLICT (actor_subject) DO UPDATE SET
        started_at=CASE WHEN spec_board_review_actor_budget.started_at <= now() - interval '1 minute'
          THEN now() ELSE spec_board_review_actor_budget.started_at END,
        actions=CASE WHEN spec_board_review_actor_budget.started_at <= now() - interval '1 minute'
          THEN 1 ELSE spec_board_review_actor_budget.actions+1 END
        WHERE spec_board_review_actor_budget.started_at <= now() - interval '1 minute'
          OR spec_board_review_actor_budget.actions < 30 RETURNING actor_subject`, [actor.subject])
      if (!allowance.length) throw Object.assign(fail(429, 'Too many discussion actions. Keep your draft and try again in a minute.', 'review-rate-limit'), { retryAfter: 60 })
      if (thread && thread.version !== payload.version) throw fail(409, 'The discussion changed. Reload it before saving.', 'review-version')
      let message = null
      if (action === 'thread') {
        const { rows: [row] } = await db.query(`INSERT INTO spec_board_review_threads
          (note_id, starter_subject, starter_login) VALUES ($1,$2,$3) RETURNING *`, [noteId, actor.subject, actor.login])
        thread = threadOf(row)
      } else {
        if (action === 'reply' && thread.resolved) throw fail(409, 'Reopen this discussion before replying.', 'review-resolved')
        if ((action === 'resolve' && thread.resolved) || (action === 'reopen' && !thread.resolved)) {
          throw fail(409, 'The discussion is already in that state. Reload it before saving.', 'review-state')
        }
        const resolved = action === 'resolve' ? true : action === 'reopen' ? false : thread.resolved
        const { rows: [row] } = await db.query(`UPDATE spec_board_review_threads SET
          version=version+1, updated_at=now(), resolved=$3,
          resolved_by_subject=CASE WHEN $4 THEN $5 WHEN $6 THEN NULL ELSE resolved_by_subject END,
          resolved_by_login=CASE WHEN $4 THEN $7 WHEN $6 THEN NULL ELSE resolved_by_login END,
          resolved_at=CASE WHEN $4 THEN now() WHEN $6 THEN NULL ELSE resolved_at END
          WHERE note_id=$1 AND id=$2 RETURNING *`,
        [noteId, thread.id, resolved, action === 'resolve', actor.subject, action === 'reopen', actor.login])
        thread = threadOf(row)
      }
      if (action === 'thread' || action === 'reply') {
        const { rows: [row] } = await db.query(`INSERT INTO spec_board_review_messages
          (note_id, thread_id, actor_subject, actor_login, body) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [noteId, thread.id, actor.subject, actor.login, payload.body])
        message = messageOf(row)
      }
      const { rows: [event] } = await db.query(`INSERT INTO spec_board_review_events
        (note_id, actor_subject, actor_login, action, thread_id, message_id, thread_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [noteId, actor.subject, actor.login, action, thread.id, message?.id || null, thread.version])
      const result = { noteId, action, threadId: thread.id, messageId: message?.id || null,
        version: thread.version, resolved: thread.resolved, eventId: String(event.id), replayed: false }
      await db.query(`INSERT INTO spec_board_review_requests
        (note_id, actor_subject, request_id, request_hash, result) VALUES ($1,$2,$3,$4,$5)`,
      [noteId, actor.subject, payload.requestId, requestHash, JSON.stringify(result)])
      return result
    })
  }

  async function read (noteId, options = {}, validate = async () => {}) {
    return tx(async db => {
      await validate(db)
      const threadLimit = options.limit || 20
      const messageLimit = options.messageLimit || 20
      const activityLimit = options.activityLimit || 50
      const { rows: threads } = await db.query(`SELECT * FROM spec_board_review_threads WHERE note_id=$1
        AND ($2::bigint IS NULL OR id > $2) AND ($3::bigint IS NULL OR id=$3)
        ORDER BY id LIMIT $4`, [noteId, options.after || null, options.threadId || null, threadLimit + 1])
      const hasMore = threads.length > threadLimit
      const shown = threads.slice(0, threadLimit)
      const populated = []
      for (const row of shown) {
        const { rows: messages } = await db.query(`SELECT * FROM spec_board_review_messages
          WHERE note_id=$1 AND thread_id=$2 AND ($3::bigint IS NULL OR id > $3)
          ORDER BY id LIMIT $4`, [noteId, row.id, options.messageAfter || null, messageLimit + 1])
        populated.push({ ...threadOf(row), messages: messages.slice(0, messageLimit).map(messageOf),
          nextMessageCursor: messages.length > messageLimit ? String(messages[messageLimit - 1].id) : null })
      }
      const { rows: activity } = await db.query(`SELECT * FROM spec_board_review_events
        WHERE note_id=$1 AND ($2::bigint IS NULL OR id > $2) ORDER BY id LIMIT $3`,
      [noteId, options.activityAfter || null, activityLimit + 1])
      return { noteId, ...await status(noteId, db), threads: populated,
        activity: activity.slice(0, activityLimit).map(eventOf),
        nextCursor: hasMore ? String(shown.at(-1).id) : null,
        nextActivityCursor: activity.length > activityLimit ? String(activity[activityLimit - 1].id) : null }
    }, true)
  }

  async function context (noteId, { maxBytes = 64000, maxMessages = 200, maxThreads = 100 } = {}, validate = async () => {}) {
    return tx(async db => {
      await validate(db)
      const incomplete = () => { throw fail(413, 'The discussion exceeds the summary context limit. No messages were omitted.', 'review-context-incomplete') }
      const { rows: threads } = await db.query('SELECT * FROM spec_board_review_threads WHERE note_id=$1 ORDER BY id LIMIT $2', [noteId, maxThreads + 1])
      if (threads.length > maxThreads) incomplete()
      const { rows: messages } = await db.query('SELECT * FROM spec_board_review_messages WHERE note_id=$1 ORDER BY id LIMIT $2', [noteId, maxMessages + 1])
      if (messages.length > maxMessages) incomplete()
      const grouped = new Map(threads.map(row => [String(row.id), { ...threadOf(row), messages: [] }]))
      for (const row of messages) grouped.get(String(row.thread_id)).messages.push(messageOf(row))
      const result = { noteId, ...await status(noteId, db), threads: [...grouped.values()], complete: true }
      if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) incomplete()
      return result
    }, true)
  }

  function approvalInput (event) {
    if (!['approve', 'retract'].includes(event.action) || typeof event.actor?.subject !== 'string' ||
        !/^[1-9]\d{0,19}$/.test(event.actor.subject) || typeof event.actor.login !== 'string' ||
        !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(event.actor.login) ||
        typeof event.noteId !== 'string' || !/^[\w-]{1,128}$/.test(event.noteId) ||
        (event.bodyHash != null && !/^[a-f0-9]{64}$/.test(event.bodyHash)) ||
        (event.requestId != null && (typeof event.requestId !== 'string' || !/^[\w-]{16,128}$/.test(event.requestId)))) {
      throw new Error('Invalid approval activity')
    }
  }

  async function approvalReceipt (db, event) {
    approvalInput(event)
    if (!event.requestId) return null
    const { rows: [previous] } = await db.query(`SELECT * FROM spec_board_review_events
      WHERE note_id=$1 AND actor_subject=$2 AND request_id=$3 AND action IN ('approve','retract')`,
    [event.noteId, event.actor.subject, event.requestId])
    if (!previous) return null
    if (previous.action !== event.action || previous.body_hash !== (event.bodyHash || null)) throw fail(409, 'This approval request ID was already used for a different action.')
    return { ...eventOf(previous), replayed: true }
  }

  const approvalRequest = event => ({ key: 'approval:' + event.requestId,
    hash: digest(JSON.stringify(['approval', event.noteId, event.actor.subject, event.action, event.requestId])) })

  async function readApprovalReceipt (db, event) {
    approvalInput(event)
    if (!event.requestId) throw new Error('An approval request ID is required')
    const request = approvalRequest(event)
    const { rows: [row] } = await db.query(`SELECT request_hash, result FROM spec_board_review_requests
      WHERE note_id=$1 AND actor_subject=$2 AND request_id=$3`, [event.noteId, event.actor.subject, request.key])
    if (!row) return null
    if (row.request_hash !== request.hash) throw fail(409, 'This approval request ID was already used for a different action.')
    return row.result
  }

  async function saveApprovalReceipt (db, event, result) {
    approvalInput(event)
    if (!event.requestId) throw new Error('An approval request ID is required')
    const encoded = JSON.stringify(result)
    if (!result || typeof result !== 'object' || Array.isArray(result) || Buffer.byteLength(encoded) > 4096) throw new Error('Invalid approval receipt result')
    const request = approvalRequest(event)
    const { rows: [row] } = await db.query(`INSERT INTO spec_board_review_requests
      (note_id, actor_subject, request_id, request_hash, result) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT DO NOTHING RETURNING result`, [event.noteId, event.actor.subject, request.key, request.hash, encoded])
    if (row) return row.result
    return readApprovalReceipt(db, event)
  }

  async function recordApproval (db, event) {
    approvalInput(event)
    const action = event.action
    const { rows: [row] } = await db.query(`INSERT INTO spec_board_review_events
      (note_id, actor_subject, actor_login, action, body_hash, request_id) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (note_id, actor_subject, request_id) WHERE action IN ('approve', 'retract') AND request_id IS NOT NULL
      DO NOTHING RETURNING *`, [event.noteId, event.actor.subject, event.actor.login, action, event.bodyHash || null, event.requestId || null])
    if (row) return { ...eventOf(row), replayed: false }
    const previous = await approvalReceipt(db, event)
    if (!previous) throw fail(409, 'The approval activity changed. Reload the review history.')
    return previous
  }

  async function recordRoundEnded (db, { noteId, bodyHash }) {
    if (typeof noteId !== 'string' || !/^[\w-]{1,128}$/.test(noteId) ||
        typeof bodyHash !== 'string' || !/^[a-f0-9]{64}$/.test(bodyHash)) throw new Error('Invalid approval round activity')
    const { rows: [row] } = await db.query(`INSERT INTO spec_board_review_events
      (note_id, actor_subject, actor_login, action, body_hash)
      VALUES ($1,'0','SpecDoc','approval-round-ended',$2) RETURNING *`, [noteId, bodyHash])
    return eventOf(row)
  }

  async function withPublicationGate (noteId, task) {
    return tx(async db => {
      await lock(db, noteId)
      const count = await openCount(noteId, db)
      if (count) throw Object.assign(fail(409, 'Resolve general discussions before publishing this spec.', 'review-open'), { openDiscussions: count })
      return task(db)
    })
  }

  async function cleanup ({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid review cleanup limit')
    const { rows } = await pool.query(`SELECT note_id FROM (
      SELECT note_id FROM spec_board_review_threads UNION SELECT note_id FROM spec_board_review_events
      UNION SELECT note_id FROM spec_board_review_requests) orphan
      WHERE NOT EXISTS (SELECT 1 FROM "Notes" n WHERE n.shortid=orphan.note_id) ORDER BY note_id LIMIT $1`, [limit])
    const removed = { notes: 0, requests: 0, events: 0, messages: 0, threads: 0 }
    for (const { note_id: noteId } of rows) {
      try {
        const counts = await tx(async db => {
          await lock(db, noteId)
          if ((await db.query('SELECT 1 FROM "Notes" WHERE shortid=$1', [noteId])).rows.length) return null
          const counts = {}
          for (const kind of ['requests', 'events', 'messages', 'threads']) {
            counts[kind] = (await db.query(`DELETE FROM spec_board_review_${kind} WHERE note_id=$1
              AND NOT EXISTS (SELECT 1 FROM "Notes" WHERE shortid=$1)`, [noteId])).rowCount
          }
          return counts
        })
        if (counts) {
          removed.notes++
          for (const key of Object.keys(counts)) removed[key] += counts[key]
        }
      } catch (error) { if (error.code !== 'review-busy') throw error }
    }
    await pool.query("DELETE FROM spec_board_review_actor_budget WHERE started_at < now() - interval '1 day'")
    await pool.query("DELETE FROM spec_board_review_attempt_budget WHERE started_at < now() - interval '1 day'")
    return removed
  }

  return { migrate, admit, mutate, read, context, status, openCount, recordApproval, recordRoundEnded,
    readApprovalReceipt, saveApprovalReceipt, withPublicationGate, cleanup }
}

module.exports = { createReviewStore, fail, digest }
