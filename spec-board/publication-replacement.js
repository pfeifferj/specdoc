'use strict'

const { digest, receiptMatches } = require('./publication-candidate')
const { recordEvent } = require('./publication-intent')

const sha = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value || '')

async function pendingInitialIntents (db, noteId) {
  const { rows } = await db.query(`SELECT i.* FROM spec_board_publication_intents i
    WHERE note_id=$1 AND revision=0 AND path IS NOT NULL AND redacted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM spec_board_governance_events e
        WHERE e.action='publication-superseded' AND e.evidence->>'submission'=i.id::text)
    ORDER BY created_at DESC LIMIT 21`, [noteId])
  if (rows.length > 20) throw new Error('Publication recovery needs operator reconciliation')
  return rows
}

function ownedPull (pr, intent) {
  return pr?.number === intent.pr_number && sha(pr.head?.sha) &&
    pr.head?.repo?.full_name?.toLowerCase() === intent.namespace.toLowerCase() &&
    pr.base?.repo?.full_name?.toLowerCase() === intent.namespace.toLowerCase() &&
    pr.head.ref === intent.branch && pr.base.ref === intent.base_branch &&
    typeof pr.body === 'string' && pr.body.includes(
      `<!-- specdoc-intent:${intent.id};candidate:${intent.candidate_hash};note:${intent.note_id} -->`)
}

async function closePendingPublication (gh, recover, intent, token) {
  if (typeof intent.path !== 'string' || intent.path.length > 1024 ||
      intent.path.split('/').some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\\]/.test(part))) {
    throw new Error('Pending publication path is invalid')
  }
  const repo = `/repos/${intent.namespace}`
  const pull = `${repo}/pulls/${intent.pr_number}`
  let pr = await gh('GET', pull, null, token)
  const verify = async value => {
    if (!ownedPull(value, intent)) throw new Error('Pending publication PR does not match its authorized submission')
    if (value.merged_at || value.merged) {
      const receipt = await recover(intent, token)
      if (!receiptMatches(receipt, intent, intent.namespace, intent.note_id)) throw new Error('Pending publication merge could not be verified')
      return { merged: receipt }
    }
    if (value.state === 'open') {
      const file = await gh('GET', `${repo}/contents/${intent.path.split('/').map(encodeURIComponent).join('/')}?ref=${value.head.sha}`, null, token)
      if (file.encoding !== 'base64' || typeof file.content !== 'string' || file.content.length > 2 * 1024 * 1024 ||
          digest(Buffer.from(file.content, 'base64')) !== intent.document_hash) throw new Error('Pending publication file differs from its authorized submission')
    }
    return null
  }
  const initial = await verify(pr)
  if (initial) return initial
  const head = pr.head.sha
  if (pr.state === 'open') {
    let closeError
    try { await gh('PATCH', pull, { state: 'closed' }, token) } catch (error) { closeError = error }
    pr = await gh('GET', pull, null, token)
    const landed = await verify(pr)
    if (landed) return landed
    if (pr.state !== 'closed' && closeError) throw closeError
  }
  if (pr.state !== 'closed' || pr.head.sha !== head) throw new Error('Pending publication changed while closing')
  return { closed: { namespace: intent.namespace, number: intent.pr_number, head, submission: intent.id } }
}

async function supersedePendingPublication (db, previous, replacement, generation, closed) {
  const { rows: [state] } = await db.query('SELECT * FROM spec_board_state WHERE note_id=$1 FOR UPDATE', [previous.note_id])
  if (!state || String(state.publication_generation) !== String(generation)) return { applied: false, state }
  const { rows } = await db.query('SELECT * FROM spec_board_publication_intents WHERE id=ANY($1::uuid[]) FOR SHARE', [[previous.id, replacement.id]])
  const old = rows.find(row => row.id === previous.id)
  const next = rows.find(row => row.id === replacement.id)
  if (!old || !next || old.redacted_at || next.redacted_at || old.merged_commit || old.revision !== 0 || next.revision !== 0 ||
      old.note_id !== next.note_id || old.namespace !== next.namespace || old.candidate_hash === next.candidate_hash ||
      state.namespace !== old.namespace || state.pr_number !== old.pr_number || state.pr_state === 'merged' ||
      state.published_commit || state.publication_receipt || state.implemented_at ||
      (state.published_candidate_hash && state.published_candidate_hash !== old.candidate_hash) ||
      (state.published_hash && state.published_hash !== old.document_hash) ||
      closed?.submission !== old.id || closed.namespace !== old.namespace || closed.number !== old.pr_number || !sha(closed.head)) {
    throw new Error('Only the verified unmerged publication can be replaced')
  }
  const superseded = await db.query(`SELECT 1 FROM spec_board_governance_events WHERE action='publication-superseded'
    AND evidence->>'submission'=ANY($1::text[])`, [[old.id, next.id]])
  if (superseded.rows.length) throw new Error('Publication submission was already superseded')
  await recordEvent(db, old.note_id, 'service', 'publication-superseded',
    { submission: old.id, replacement: next.id, number: old.pr_number, namespace: old.namespace, head: closed.head })
  const { rows: [cleared] } = await db.query(`UPDATE spec_board_state SET pr_number=NULL,pr_state=NULL,spec_path=NULL,
    published_hash=NULL,published_commit=NULL,published_candidate_hash=NULL,publication_receipt=NULL,revision=0,revision_pr=NULL
    WHERE note_id=$1 RETURNING *`, [old.note_id])
  return { applied: true, state: cleared }
}

module.exports = { closePendingPublication, supersedePendingPublication, pendingInitialIntents }
