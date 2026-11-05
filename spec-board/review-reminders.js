const crypto = require('crypto')

const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const loginKey = value => String(value || '').toLowerCase()

function pendingReviewers (review) {
  if (!review || review.public !== true || review.policyKnown !== true ||
      !['ready-for-review', 'in-review', 'approved'].includes(review.status) || review.retired ||
      review.blocked || !Number.isSafeInteger(review.required) || review.required <= 0 ||
      !Array.isArray(review.approvers) || !Array.isArray(review.approved)) return []
  const roster = [...new Set(review.approvers.map(loginKey))]
  const approved = new Set(review.approved.map(loginKey))
  if (!roster.length || roster.length > 1000 || review.required > roster.length ||
      roster.some(login => !/^[\w.-]{1,64}$/.test(login))) return []
  if (roster.filter(login => approved.has(login)).length >= review.required) return []
  return roster.filter(login => !approved.has(login)).sort()
}

function reviewVersion (review) {
  return fingerprint([review.namespace, review.contentHash, review.policyHash, review.required,
    [...new Set((review.approvers || []).map(loginKey))].sort()])
}

function reminderCurrent (review, value) {
  return value && value.kind === 'review-attention' && reviewVersion(review || {}) === value.reviewVersion &&
    pendingReviewers(review).includes(loginKey(value.reviewer))
}

function createReviewReminders ({ db, withTx, loadReview, recipients, enqueue, delayHours = 24, batchLimit = 8 }) {
  if (!Number.isFinite(delayHours) || delayHours < 0 || delayHours > 8760) throw new Error('Invalid review reminder delay')
  const limit = Math.max(1, Math.min(100, batchLimit))

  async function migrate () {
    await db.query(`CREATE TABLE IF NOT EXISTS spec_board_review_reminders (
      note_id text NOT NULL, reviewer text NOT NULL, version text NOT NULL,
      first_seen_at timestamptz NOT NULL DEFAULT now(), queued_at timestamptz, last_attempt_at timestamptz,
      PRIMARY KEY (note_id, reviewer, version))`)
    await db.query('ALTER TABLE spec_board_review_reminders ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz')
  }

  async function observe (noteId) {
    if (!delayHours) return { queued: 0 }
    const review = await loadReview(noteId)
    if (!review || review.policyKnown !== true) return { queued: 0 }
    const pending = pendingReviewers(review)
    if (!pending.length) return { queued: 0 }
    const version = reviewVersion(review)
    await db.query(`INSERT INTO spec_board_review_reminders (note_id, reviewer, version)
      SELECT $1, reviewer, $3 FROM unnest($2::text[]) AS reviewer
      ON CONFLICT (note_id, reviewer, version) DO NOTHING`, [noteId, pending, version])
    let queued = 0
    await withTx(async client => {
      const { rows } = await client.query(`SELECT reviewer, version FROM spec_board_review_reminders
        WHERE note_id=$1 AND version=$2 AND queued_at IS NULL
          AND first_seen_at <= now() - ($3 * interval '1 hour')
          AND (last_attempt_at IS NULL OR last_attempt_at < now() - interval '1 hour')
        ORDER BY COALESCE(last_attempt_at, first_seen_at), reviewer LIMIT $4 FOR UPDATE SKIP LOCKED`, [noteId, version, delayHours, limit])
      if (!rows.length) return
      const current = await loadReview(noteId, client, { refreshPolicy: true })
      if (!current || current.policyKnown !== true || reviewVersion(current) !== version) return
      const stillPending = new Set(pendingReviewers(current))
      for (const row of rows) {
        if (!stillPending.has(row.reviewer)) continue
        await client.query(`UPDATE spec_board_review_reminders SET last_attempt_at=now()
          WHERE note_id=$1 AND reviewer=$2 AND version=$3`, [noteId, row.reviewer, version])
        const addresses = await recipients(current, row.reviewer, client)
        if (!addresses.length) continue
        await enqueue(current, {
          version: 1, kind: 'review-attention', reviewer: row.reviewer, reviewVersion: version,
          namespace: current.namespace, noteUrl: current.url, url: current.reviewUrl || current.url,
          line: `Your review is needed on "${current.title}".`, reasons: ['review-requested']
        }, addresses, client)
        await client.query(`UPDATE spec_board_review_reminders SET queued_at=now()
          WHERE note_id=$1 AND reviewer=$2 AND version=$3`, [noteId, row.reviewer, version])
        queued++
      }
    })
    return { queued }
  }

  async function partition (rows, email) {
    const loaded = new Map()
    const visible = []
    const deferred = []
    for (const row of rows) {
      if (row.event?.kind !== 'review-attention') { visible.push(row); continue }
      if (!delayHours) continue
      if (!loaded.has(row.note_id)) loaded.set(row.note_id, await loadReview(row.note_id, db, { refreshPolicy: true }))
      const review = loaded.get(row.note_id)
      if (review?.public && review.policyKnown !== true) { deferred.push(row); continue }
      if (!reminderCurrent(review, row.event)) continue
      if (email) {
        const addresses = await recipients(review, row.event.reviewer, db)
        if (!addresses.some(address => address.email.toLowerCase() === email.toLowerCase())) continue
      }
      visible.push(row)
    }
    return { visible, deferred }
  }

  async function filter (rows, email) {
    const result = await partition(rows, email)
    if (result.deferred.length) throw new Error('Current review reminder policy is unavailable')
    return result.visible
  }

  return { migrate, observe, filter, partition }
}

module.exports = { createReviewReminders, pendingReviewers, reviewVersion, reminderCurrent }
