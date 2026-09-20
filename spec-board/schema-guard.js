async function publicationGuard (db) {
  try {
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS spec_board_state_ns_pr
      ON spec_board_state (namespace, pr_number) WHERE pr_number IS NOT NULL`)
    const { rows: [index] } = await db.query(`SELECT i.indisvalid, i.indisunique, i.indnkeyatts, i.indexprs IS NULL AS plain_columns,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(num, pos)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num ORDER BY k.pos) AS columns,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i WHERE i.indexrelid=to_regclass('spec_board_state_ns_pr')
        AND i.indrelid='spec_board_state'::regclass`)
    if (!index || !index.indisvalid || !index.indisunique || index.indnkeyatts !== 2 || !index.plain_columns ||
        JSON.stringify(index.columns) !== JSON.stringify(['namespace', 'pr_number']) || index.predicate !== '(pr_number IS NOT NULL)') {
      throw new Error('Publication identity index is missing, invalid or has an unexpected definition')
    }
    return { ready: true, checkedAt: Date.now(), reason: null }
  } catch (error) {
    console.error('publication identity guard:', error.message)
    return { ready: false, checkedAt: Date.now(), reason: 'Repair spec_board_state_ns_pr before publishing or relinking specs' }
  }
}

module.exports = { publicationGuard }
