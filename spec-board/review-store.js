const crypto = require('crypto')
const { AsyncLocalStorage } = require('node:async_hooks')
const publicationScope = new AsyncLocalStorage()

function assertPublicationLock () {
  if (publicationScope.getStore()?.aborted) throw fail(409, 'Publication stopped after its discussion lock was lost. Try again shortly.', 'review-busy')
}

const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) })
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const actorOf = row => ({ subject: row.actor_subject, login: row.actor_login,
  ...(row.actor_kind === 'automation' ? { kind: 'automation' } : {}) })
const messageOf = row => ({ id: String(row.id),
  body: row.hidden ? '[Message hidden because its author is suspended.]' : row.body,
  ...(row.hidden ? { hidden: true } : {}), actor: actorOf(row), createdAt: row.created_at })
const threadOf = row => ({ id: String(row.id), starter: { subject: row.starter_subject, login: row.starter_login,
  ...(row.starter_kind === 'automation' ? { kind: 'automation' } : {}) },
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
        action text NOT NULL CHECK (action IN ('thread', 'reply', 'resolve', 'reopen', 'recover', 'finding', 'approve', 'retract', 'approval-round-ended')),
        thread_id bigint, message_id bigint, thread_version integer, body_hash text,
        request_id text, created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (thread_id, note_id) REFERENCES spec_board_review_threads (id, note_id)
      )`)
      await db.query('ALTER TABLE spec_board_review_events DROP CONSTRAINT IF EXISTS spec_board_review_events_action_check')
      await db.query(`ALTER TABLE spec_board_review_events ADD CONSTRAINT spec_board_review_events_action_check
        CHECK (action IN ('thread', 'reply', 'resolve', 'reopen', 'recover', 'finding', 'approve', 'retract', 'approval-round-ended'))`)
      await db.query('CREATE INDEX IF NOT EXISTS spec_board_review_events_note ON spec_board_review_events (note_id, id)')
      await db.query('CREATE INDEX IF NOT EXISTS spec_board_review_events_thread ON spec_board_review_events (thread_id, id)')
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
      await db.query("ALTER TABLE spec_board_review_threads ADD COLUMN IF NOT EXISTS starter_kind text NOT NULL DEFAULT 'human'")
      await db.query('ALTER TABLE spec_board_review_threads ADD COLUMN IF NOT EXISTS finding_key text')
      await db.query("ALTER TABLE spec_board_review_threads ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'")
      await db.query('CREATE UNIQUE INDEX IF NOT EXISTS spec_board_review_finding_key ON spec_board_review_threads(finding_key) WHERE finding_key IS NOT NULL')
      for (const table of ['messages', 'events']) {
        await db.query(`ALTER TABLE spec_board_review_${table} ADD COLUMN IF NOT EXISTS actor_kind text NOT NULL DEFAULT 'human'`)
      }
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_review_thread_notes (
        thread_id bigint NOT NULL REFERENCES spec_board_review_threads(id), note_id text NOT NULL, namespace text,
        PRIMARY KEY(thread_id,note_id)
      )`)
      await db.query('CREATE INDEX IF NOT EXISTS spec_board_review_thread_notes_note ON spec_board_review_thread_notes(note_id,thread_id)')
      await db.query(`INSERT INTO spec_board_review_thread_notes(thread_id,note_id)
        SELECT id,note_id FROM spec_board_review_threads ON CONFLICT DO NOTHING`)
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_review_occurrences (
        thread_id bigint NOT NULL REFERENCES spec_board_review_threads(id), producer text NOT NULL,
        occurrence_key text NOT NULL, actor_subject text NOT NULL, evidence jsonb NOT NULL,
        settings_fingerprint text, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(thread_id,producer,actor_subject,occurrence_key)
      )`)
    })
  }

  async function status (noteId, db = pool) {
    const { rows: [row] } = await db.query(`SELECT
      (SELECT count(*)::integer FROM spec_board_review_threads t JOIN spec_board_review_thread_notes n ON n.thread_id=t.id
        WHERE n.note_id=$1 AND NOT t.resolved) AS open_count,
      (SELECT COALESCE(max(e.id),0)::text FROM (
        SELECT id FROM spec_board_review_events WHERE thread_id IS NULL AND note_id=$1
        UNION ALL SELECT e.id FROM spec_board_review_thread_notes n
          JOIN spec_board_review_events e ON e.thread_id=n.thread_id WHERE n.note_id=$1) e) AS version`, [noteId])
    return { openDiscussions: row.open_count, version: row.version,
      fingerprint: digest(JSON.stringify([noteId, row.version, row.open_count])) }
  }

  async function openCount (noteId, db = pool) {
    const { rows: [row] } = await db.query(`SELECT count(*)::integer AS open_count FROM spec_board_review_threads t
      JOIN spec_board_review_thread_notes n ON n.thread_id=t.id WHERE n.note_id=$1 AND NOT t.resolved`, [noteId])
    return row.open_count
  }

  async function associations (db, threadId) {
    return (await associationMap(db, [threadId])).get(String(threadId))
  }

  async function associationMap (db, threadIds) {
    const grouped = new Map(threadIds.map(id => [String(id), []]))
    if (!grouped.size) return grouped
    const { rows } = await db.query(`SELECT thread_id,note_id AS "noteId",namespace FROM spec_board_review_thread_notes
      WHERE thread_id=ANY($1::bigint[]) ORDER BY thread_id,note_id`, [[...grouped.keys()]])
    for (const { thread_id, ...item } of rows) grouped.get(String(thread_id)).push(item)
    return grouped
  }

  async function lockNotes (db, noteIds) {
    for (const noteId of [...new Set(noteIds)].sort()) await lock(db, noteId)
  }

  async function threadRow (db, noteId, threadId, locked = false) {
    const { rows: [row] } = await db.query(`SELECT t.* FROM spec_board_review_threads t
      JOIN spec_board_review_thread_notes n ON n.thread_id=t.id WHERE n.note_id=$1 AND t.id=$2 ${locked ? 'FOR UPDATE OF t' : ''}`, [noteId, threadId])
    if (!row) throw fail(404, 'Unknown discussion thread.')
    return row
  }

  async function describe (db, row, includeBody = false) {
    return (await describeMany(db, [row], includeBody))[0]
  }

  async function describeMany (db, threads, includeBody = false) {
    const ids = threads.map(row => String(row.id))
    const linked = await associationMap(db, ids)
    if (!ids.length) return []
    const { rows } = await db.query(`SELECT DISTINCT thread_id,producer FROM spec_board_review_occurrences
      WHERE thread_id=ANY($1::bigint[]) ORDER BY thread_id,producer`, [ids])
    const producers = new Map(ids.map(id => [id, []]))
    for (const row of rows) producers.get(String(row.thread_id)).push(row.producer)
    return threads.map(row => ({ ...threadOf(row), associations: linked.get(String(row.id)), evidence: (row.evidence || []).map(item => {
      const { body, ...metadata } = item
      return includeBody ? item : metadata
    }),
      occurrenceKinds: producers.get(String(row.id)) }))
  }

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
      let thread = null
      let ownerNote = noteId
      if (action !== 'thread') {
        const initial = await threadRow(db, noteId, payload.threadId)
        await lockNotes(db, (await associations(db, initial.id)).map(item => item.noteId))
        const row = await threadRow(db, noteId, payload.threadId, true)
        ownerNote = row.note_id
        thread = await describe(db, row)
      } else await lock(db, noteId)
      const { rows: [previous] } = await db.query(`SELECT request_hash, result FROM spec_board_review_requests
        WHERE note_id=$1 AND actor_subject=$2 AND request_id=$3`, [noteId, actor.subject, payload.requestId])
      const validation = await validate(db, thread, { replayed: !!previous && previous.request_hash === requestHash })
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
        await db.query('INSERT INTO spec_board_review_thread_notes(thread_id,note_id,namespace) VALUES($1,$2,$3)',
          [thread.id, noteId, validation?.namespace || null])
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
        [ownerNote, thread.id, resolved, action === 'resolve', actor.subject, action === 'reopen', actor.login])
        thread = threadOf(row)
      }
      if (action === 'thread' || action === 'reply') {
        const { rows: [row] } = await db.query(`INSERT INTO spec_board_review_messages
          (note_id, thread_id, actor_subject, actor_login, body) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [ownerNote, thread.id, actor.subject, actor.login, payload.body])
        message = messageOf(row)
      }
      const { rows: [event] } = await db.query(`INSERT INTO spec_board_review_events
        (note_id, actor_subject, actor_login, action, thread_id, message_id, thread_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [ownerNote, actor.subject, actor.login, payload.recover ? 'recover' : action, thread.id, message?.id || null, thread.version])
      const result = { noteId, action, threadId: thread.id, messageId: message?.id || null,
        version: thread.version, resolved: thread.resolved, eventId: String(event.id), replayed: false,
        noteIds: (await associations(db, thread.id)).map(item => item.noteId),
        ...(payload.recover ? { recovery: true } : {}) }
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
      const { rows: threads } = await db.query(`SELECT t.* FROM spec_board_review_threads t
        JOIN spec_board_review_thread_notes n ON n.thread_id=t.id WHERE n.note_id=$1
        AND ($2::bigint IS NULL OR t.id > $2) AND ($3::bigint IS NULL OR t.id=$3)
        ORDER BY t.id LIMIT $4`, [noteId, options.after || null, options.threadId || null, threadLimit + 1])
      const hasMore = threads.length > threadLimit
      const shown = threads.slice(0, threadLimit)
      const populated = await describeMany(db, shown)
      for (const row of populated) {
        const { rows: messages } = await db.query(`SELECT m.*, EXISTS (SELECT 1 FROM spec_board_moderation_accounts a
          WHERE a.provider='github' AND a.subject=m.actor_subject AND a.state='suspended') AS hidden FROM spec_board_review_messages m
          WHERE thread_id=$1 AND ($2::bigint IS NULL OR id > $2)
          ORDER BY id LIMIT $3`, [row.id, options.messageAfter || null, messageLimit + 1])
        row.messages = messages.slice(0, messageLimit).map(messageOf)
        row.nextMessageCursor = messages.length > messageLimit ? String(messages[messageLimit - 1].id) : null
      }
      const { rows: activity } = await db.query(`SELECT * FROM (
        SELECT e.* FROM spec_board_review_events e WHERE e.thread_id IS NULL AND e.note_id=$1
        UNION ALL SELECT e.* FROM spec_board_review_thread_notes n
          JOIN spec_board_review_events e ON e.thread_id=n.thread_id WHERE n.note_id=$1) activity
        WHERE ($2::bigint IS NULL OR id > $2) ORDER BY id LIMIT $3`,
      [noteId, options.activityAfter || null, activityLimit + 1])
      const events = []
      const eventAssociations = await associationMap(db, activity.slice(0, activityLimit).flatMap(row => row.thread_id ? [row.thread_id] : []))
      for (const row of activity.slice(0, activityLimit)) events.push({ ...eventOf(row),
        associatedNoteIds: row.thread_id ? eventAssociations.get(String(row.thread_id)).map(item => item.noteId) : [noteId] })
      const visibilityChecks = []
      if (options.visibleThreads?.length) {
        const { rows } = await db.query(`SELECT n.thread_id,t.version,t.resolved FROM spec_board_review_thread_notes n
          JOIN spec_board_review_threads t ON t.id=n.thread_id
          WHERE n.note_id=$1 AND n.thread_id=ANY($2::bigint[]) ORDER BY n.thread_id`, [noteId, options.visibleThreads])
        const linked = await associationMap(db, rows.map(row => row.thread_id))
        for (const row of rows) visibilityChecks.push({ id: String(row.thread_id), version: row.version, resolved: row.resolved,
          associations: linked.get(String(row.thread_id)) })
      }
      return { noteId, ...await status(noteId, db), threads: populated,
        activity: events, visibleThreads: options.visibleThreads || [], visibilityChecks,
        nextCursor: hasMore ? String(shown.at(-1).id) : null,
        nextActivityCursor: activity.length > activityLimit ? String(activity[activityLimit - 1].id) : null }
    }, true)
  }

  async function context (noteId, { maxBytes = 64000, maxMessages = 200, maxThreads = 100 } = {}, validate = async () => {}) {
    return tx(async db => {
      await validate(db)
      const incomplete = () => { throw fail(413, 'The discussion exceeds the summary context limit. No messages were omitted.', 'review-context-incomplete') }
      const { rows: threads } = await db.query(`SELECT t.* FROM spec_board_review_threads t
        JOIN spec_board_review_thread_notes n ON n.thread_id=t.id WHERE n.note_id=$1 ORDER BY t.id LIMIT $2`, [noteId, maxThreads + 1])
      if (threads.length > maxThreads) incomplete()
      const { rows: messages } = await db.query(`SELECT m.*, EXISTS (SELECT 1 FROM spec_board_moderation_accounts a
        WHERE a.provider='github' AND a.subject=m.actor_subject AND a.state='suspended') AS hidden
        FROM spec_board_review_messages m WHERE EXISTS
          (SELECT 1 FROM spec_board_review_thread_notes n WHERE n.thread_id=m.thread_id AND n.note_id=$1)
        ORDER BY id LIMIT $2`, [noteId, maxMessages + 1])
      if (messages.length > maxMessages) incomplete()
      const grouped = new Map()
      for (const row of await describeMany(db, threads)) grouped.set(row.id, { ...row, messages: [] })
      for (const row of messages) grouped.get(String(row.thread_id)).messages.push(messageOf(row))
      const result = { noteId, ...await status(noteId, db), threads: [...grouped.values()], complete: true }
      if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) incomplete()
      return result
    }, true)
  }

  async function findingEvidence (noteId, threadId) {
    return tx(async db => describe(db, await threadRow(db, noteId, threadId), true), true)
  }

  async function upsertFinding ({ finding, validate }) {
    const noteIds = finding.evidence.map(item => item.noteId).sort()
    return tx(async db => {
      await lockNotes(db, noteIds)
      const { namespace } = await validate(db)
      const { rows: [existing] } = await db.query('SELECT * FROM spec_board_review_threads WHERE finding_key=$1 FOR UPDATE', [finding.findingKey])
      let row = existing
      let messageId = null
      if (!row) {
        const inserted = await db.query(`INSERT INTO spec_board_review_threads
          (note_id,starter_subject,starter_login,starter_kind,finding_key,evidence)
          VALUES($1,$2,$3,'automation',$4,$5) RETURNING *`,
        [noteIds[0], finding.actor.subject, finding.actor.login, finding.findingKey, JSON.stringify(finding.evidence)])
        row = inserted.rows[0]
        for (const noteId of noteIds) await db.query(`INSERT INTO spec_board_review_thread_notes
          (thread_id,note_id,namespace) VALUES($1,$2,$3)`, [row.id, noteId, namespace])
        const message = await db.query(`INSERT INTO spec_board_review_messages
          (note_id,thread_id,actor_subject,actor_login,actor_kind,body)
          VALUES($1,$2,$3,$4,'automation',$5) RETURNING id`,
        [row.note_id, row.id, finding.actor.subject, finding.actor.login, finding.body])
        messageId = String(message.rows[0].id)
      } else if (JSON.stringify((await associations(db, row.id)).map(item => item.noteId).sort()) !== JSON.stringify(noteIds)) {
        throw fail(409, 'The finding sources changed.', 'review-finding-conflict')
      }
      const occurrence = await db.query(`INSERT INTO spec_board_review_occurrences
        (thread_id,producer,occurrence_key,actor_subject,evidence,settings_fingerprint)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING thread_id`,
      [row.id, finding.producer, finding.occurrenceKey, finding.actor.subject,
        JSON.stringify(finding.evidence.map(({ body, ...evidence }) => evidence)), finding.settingsFingerprint || null])
      if (!occurrence.rowCount) return { noteId: row.note_id, noteIds, threadId: String(row.id), version: row.version, resolved: row.resolved, replayed: true }
      if (existing) {
        return { noteId: row.note_id, noteIds, action: 'finding', threadId: String(row.id),
          version: row.version, resolved: row.resolved, created: false, replayed: false }
      }
      const { rows: [event] } = await db.query(`INSERT INTO spec_board_review_events
        (note_id,actor_subject,actor_login,actor_kind,action,thread_id,message_id,thread_version)
        VALUES($1,$2,$3,'automation','finding',$4,$5,$6) RETURNING id`,
      [row.note_id, finding.actor.subject, finding.actor.login, row.id, messageId, row.version])
      return { noteId: row.note_id, noteIds, action: 'finding', threadId: String(row.id), messageId,
        version: row.version, resolved: row.resolved, eventId: String(event.id), created: true, replayed: false }
    })
  }

  function approvalInput (event) {
    if (!['approve', 'retract'].includes(event.action) || typeof event.actor?.subject !== 'string' ||
        !/^[1-9]\d{0,19}$/.test(event.actor.subject) || typeof event.actor.login !== 'string' ||
        !/^[A-Za-z0-9-]{1,39}$/.test(event.actor.login) ||
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

  async function withPublicationLock (noteId, task) {
    const db = await pool.connect()
    const lease = new AbortController()
    const lost = error => lease.abort(error)
    db.on('error', lost)
    let locked = false
    try {
      const { rows: [row] } = await db.query("SELECT pg_try_advisory_lock(hashtext('specdoc-review'), hashtext($1)) AS locked", [noteId])
      locked = row.locked
      if (!locked) throw fail(409, 'Review discussion or publication is busy. Try again shortly.', 'review-busy')
      return await publicationScope.run(lease.signal, async () => {
        assertPublicationLock()
        const result = await task({ signal: lease.signal })
        assertPublicationLock()
        return result
      })
    } finally {
      let releaseError = lease.signal.aborted ? lease.signal.reason : undefined
      if (locked) {
        try { await db.query("SELECT pg_advisory_unlock(hashtext('specdoc-review'), hashtext($1))", [noteId]) } catch (error) { releaseError = error }
      }
      db.release(releaseError)
      db.removeListener('error', lost)
    }
  }

  async function cleanup ({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid review cleanup limit')
    const { rows } = await pool.query(`SELECT note_id FROM (
      SELECT t.note_id FROM spec_board_review_threads t WHERE NOT EXISTS
        (SELECT 1 FROM spec_board_review_thread_notes a JOIN "Notes" n ON n.shortid=a.note_id WHERE a.thread_id=t.id)
      UNION SELECT note_id FROM spec_board_review_events WHERE thread_id IS NULL
      UNION SELECT note_id FROM spec_board_review_requests) orphan
      WHERE NOT EXISTS (SELECT 1 FROM "Notes" n WHERE n.shortid=orphan.note_id) ORDER BY note_id LIMIT $1`, [limit])
    const removed = { notes: 0, requests: 0, events: 0, messages: 0, threads: 0 }
    for (const { note_id: noteId } of rows) {
      try {
        const counts = await tx(async db => {
          const { rows: linked } = await db.query(`SELECT DISTINCT a.note_id FROM spec_board_review_thread_notes a
            JOIN spec_board_review_threads t ON t.id=a.thread_id WHERE t.note_id=$1`, [noteId])
          await lockNotes(db, [noteId, ...linked.map(item => item.note_id)])
          if ((await db.query('SELECT 1 FROM "Notes" WHERE shortid=$1', [noteId])).rows.length) return null
          const { rows: orphaned } = await db.query(`SELECT t.id FROM spec_board_review_threads t WHERE t.note_id=$1 AND NOT EXISTS
            (SELECT 1 FROM spec_board_review_thread_notes a JOIN "Notes" n ON n.shortid=a.note_id WHERE a.thread_id=t.id)`, [noteId])
          const ids = orphaned.map(item => item.id)
          const counts = { requests: (await db.query('DELETE FROM spec_board_review_requests WHERE note_id=$1', [noteId])).rowCount }
          counts.events = (await db.query(`DELETE FROM spec_board_review_events WHERE thread_id=ANY($1::bigint[])
            OR (thread_id IS NULL AND note_id=$2)`, [ids, noteId])).rowCount
          counts.messages = (await db.query('DELETE FROM spec_board_review_messages WHERE thread_id=ANY($1::bigint[])', [ids])).rowCount
          await db.query('DELETE FROM spec_board_review_occurrences WHERE thread_id=ANY($1::bigint[])', [ids])
          await db.query('DELETE FROM spec_board_review_thread_notes WHERE thread_id=ANY($1::bigint[])', [ids])
          counts.threads = (await db.query('DELETE FROM spec_board_review_threads WHERE id=ANY($1::bigint[])', [ids])).rowCount
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

  return { migrate, admit, mutate, read, context, status, openCount, upsertFinding, findingEvidence, recordApproval, recordRoundEnded,
    readApprovalReceipt, saveApprovalReceipt, lockReview: lock, withPublicationLock, cleanup }
}

module.exports = { createReviewStore, fail, digest, assertPublicationLock }
