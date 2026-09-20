const columns = `note_id, namespace, pr_number, pr_state, category, spec_path,
  published_hash, published_commit, revision, revision_pr, publication_generation`

async function readPublication (db, noteId) {
  return (await db.query(`SELECT ${columns} FROM spec_board_state WHERE note_id=$1 FOR UPDATE`, [noteId])).rows[0] || null
}

// Callers keep each claim and completion inside their own transaction. Remote
// work happens between them, without holding a database row lock.
async function claimPublication (db, noteId, assertAllowed) {
  assertAllowed()
  const current = await readPublication(db, noteId)
  if (!current) return null
  assertAllowed()
  return (await db.query(`UPDATE spec_board_state SET publication_generation=publication_generation+1
    WHERE note_id=$1 RETURNING ${columns}`, [noteId])).rows[0]
}

async function completePublication (db, noteId, generation, write) {
  const current = await readPublication(db, noteId)
  if (!current || generation == null || String(current.publication_generation) !== String(generation)) {
    return { applied: false, state: current }
  }
  const value = await write(db, current)
  const state = await readPublication(db, noteId)
  if (!state || (current.pr_number && (state.pr_number !== current.pr_number ||
      (current.namespace && state.namespace !== current.namespace)))) {
    throw new Error('A publication cannot replace its recorded namespace or PR identity')
  }
  return { applied: true, state, value }
}

module.exports = { claimPublication, completePublication }
