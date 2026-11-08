function createReviewDeliveryStore (pool) {
  async function list () {
    const { rows } = await pool.query(`SELECT note_id,bot_name,reviewed_hash,
      delivery->>'state' AS delivery_state,delivery->'retryAt' AS retry_at
      FROM spec_board_reviews`)
    return rows
  }

  async function read (noteId, botName) {
    const { rows: [row] } = await pool.query(`SELECT reviewed_hash,delivery FROM spec_board_reviews
      WHERE note_id=$1 AND bot_name=$2`, [noteId, botName])
    return row || null
  }

  async function saveNew (noteId, botName, hash, delivery, previousHash = null) {
    const { rows: [row] } = await pool.query(`INSERT INTO spec_board_reviews
      (note_id,bot_name,reviewed_hash,delivery) VALUES($1,$2,$3,$4)
      ON CONFLICT(note_id,bot_name) DO UPDATE SET
        reviewed_hash=EXCLUDED.reviewed_hash,
        delivery=CASE WHEN spec_board_reviews.reviewed_hash=EXCLUDED.reviewed_hash
          THEN spec_board_reviews.delivery ELSE EXCLUDED.delivery END
      WHERE spec_board_reviews.reviewed_hash=EXCLUDED.reviewed_hash
        OR spec_board_reviews.reviewed_hash=$5
      RETURNING reviewed_hash,delivery`, [noteId, botName, hash, delivery === null ? null : JSON.stringify(delivery), previousHash])
    return row || null
  }

  async function update (noteId, botName, hash, runId, delivery) {
    const { rowCount } = await pool.query(`UPDATE spec_board_reviews SET delivery=$5
      WHERE note_id=$1 AND bot_name=$2 AND reviewed_hash=$3 AND delivery->>'id'=$4 AND delivery->>'state'='pending'`,
    [noteId, botName, hash, runId, delivery === null ? null : JSON.stringify(delivery)])
    return rowCount === 1
  }

  async function sweep (activeNotes, activeBots, now = Date.now()) {
    if (!Number.isFinite(now)) throw new TypeError('Review delivery cleanup needs a finite timestamp')
    const notes = activeNotes.map(({ id, namespace }) => ({ id, namespace }))
    const bots = activeBots.map(({ name, namespaces }) => ({ name, namespaces }))
    const removed = await pool.query(`WITH orphaned AS MATERIALIZED (
        SELECT r.note_id,r.bot_name,r.reviewed_hash,r.delivery->>'id' AS run_id FROM spec_board_reviews r
        WHERE NOT EXISTS (SELECT 1 FROM "Notes" n WHERE n.shortid=r.note_id)
          OR NOT EXISTS (SELECT 1 FROM spec_board_bots b WHERE b.name=r.bot_name)
      )
      DELETE FROM spec_board_reviews r USING orphaned o
      WHERE r.note_id=o.note_id AND r.bot_name=o.bot_name AND r.reviewed_hash=o.reviewed_hash
        AND (r.delivery->>'id') IS NOT DISTINCT FROM o.run_id`)
    const changed = await pool.query(`WITH active_notes AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS n(id text,namespace text)
      ), active_bots AS (
        SELECT * FROM jsonb_to_recordset($2::jsonb) AS b(name text,namespaces jsonb)
      ), candidates AS MATERIALIZED (
        SELECT r.note_id,r.bot_name,r.reviewed_hash,r.delivery->>'id' AS run_id,
          CASE
            WHEN CASE WHEN jsonb_typeof(r.delivery->'expiresAt')='number'
              THEN (r.delivery->>'expiresAt')::numeric <= $3 ELSE true END THEN 'expired'
            WHEN NOT EXISTS (SELECT 1 FROM active_bots b WHERE b.name=r.bot_name
              AND b.namespaces ? (r.delivery->>'namespace')) THEN 'bot-unavailable'
            WHEN NOT EXISTS (SELECT 1 FROM active_notes n WHERE n.id=r.note_id AND n.namespace=r.delivery->>'namespace')
              OR jsonb_typeof(r.delivery->'noteIds') IS DISTINCT FROM 'array'
              OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.delivery->'noteIds')='array'
                  THEN r.delivery->'noteIds' ELSE '[]'::jsonb END) AS source(id)
                WHERE NOT EXISTS (SELECT 1 FROM active_notes n WHERE n.id=source.id AND n.namespace=r.delivery->>'namespace'))
              THEN 'source-unavailable'
          END AS reason
        FROM spec_board_reviews r WHERE r.delivery->>'state'='pending'
      )
      UPDATE spec_board_reviews r SET delivery=jsonb_build_object('id',c.run_id,'state','failed','reason',c.reason)
      FROM candidates c WHERE c.reason IS NOT NULL AND r.note_id=c.note_id AND r.bot_name=c.bot_name
        AND r.reviewed_hash=c.reviewed_hash AND r.delivery->>'id'=c.run_id AND r.delivery->>'state'='pending'`,
    [JSON.stringify(notes), JSON.stringify(bots), now])
    return { deleted: removed.rowCount, failed: changed.rowCount }
  }

  return { list, read, saveNew, update, sweep }
}

module.exports = { createReviewDeliveryStore }
