const { fail } = require('./roadmap')

const milestone = row => ({ id: String(row.id), namespace: row.namespace, title: row.title, description: row.description,
  dueDate: row.due_date, state: row.state, checkpointTag: row.checkpoint_tag, checkpointCommit: row.checkpoint_commit,
  checkpointLinkedAt: row.checkpoint_linked_at, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at })
const columns = 'id, namespace, title, description, due_date::text, state, checkpoint_tag, checkpoint_commit, checkpoint_linked_at, version, created_at, updated_at'
function createRoadmapStore (pool) {
  async function tx (fn, readOnly = false) {
    const db = await pool.connect()
    try {
      await db.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
      const result = await fn(db)
      await db.query('COMMIT')
      return result
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {})
      throw e
    } finally { db.release() }
  }
  async function migrate () {
    await tx(async db => {
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_milestones (
        id bigserial PRIMARY KEY, namespace text NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '',
        due_date date, state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
        checkpoint_tag text, checkpoint_commit text, checkpoint_linked_at timestamptz,
        version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (id, namespace)
      )`)
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_planning (
        note_id text PRIMARY KEY, namespace text NOT NULL, milestone_id bigint, version integer NOT NULL DEFAULT 0,
        changed_by text, changed_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (milestone_id, namespace) REFERENCES spec_board_milestones(id, namespace)
      )`)
      await db.query('CREATE INDEX IF NOT EXISTS spec_board_planning_milestone ON spec_board_planning (milestone_id)')
      await db.query('CREATE INDEX IF NOT EXISTS spec_board_planning_namespace ON spec_board_planning (namespace, note_id)')
      await db.query('CREATE INDEX IF NOT EXISTS spec_board_milestones_namespace ON spec_board_milestones (namespace, id)')
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_implementers (
        note_id text NOT NULL REFERENCES spec_board_planning(note_id), user_id text NOT NULL,
        PRIMARY KEY (note_id, user_id)
      )`)
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_planning_events (
        id bigserial PRIMARY KEY, note_id text NOT NULL, actor text NOT NULL, action text NOT NULL,
        value jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      )`)
    })
  }
  async function read ({ namespaces = null, noteIds = null } = {}) {
    return tx(async db => {
      const ms = await db.query(`SELECT ${columns} FROM spec_board_milestones
        WHERE ($1::text[] IS NULL OR namespace = ANY($1)) ORDER BY id`, [namespaces])
      const assignments = await db.query(`SELECT p.note_id, p.namespace, p.milestone_id, p.version,
        COALESCE(jsonb_agg(jsonb_build_object('id', u.id::text,
          'login', COALESCE(u.profile::jsonb->>'username', ''),
          'name', COALESCE(u.profile::jsonb->>'displayName', u.profile::jsonb->>'username', 'User'))
          ORDER BY u.id::text) FILTER (WHERE u.id IS NOT NULL), '[]'::jsonb) AS implementers
        FROM spec_board_planning p LEFT JOIN spec_board_implementers i ON i.note_id = p.note_id
        LEFT JOIN "Users" u ON u.id::text = i.user_id
        WHERE ($1::text[] IS NULL OR p.namespace = ANY($1))
          AND ($2::text[] IS NULL OR p.note_id = ANY($2))
        GROUP BY p.note_id`, [namespaces, noteIds])
      return { milestones: ms.rows.map(milestone), assignments: assignments.rows.map(r => ({ noteId: r.note_id,
        namespace: r.namespace, milestoneId: r.milestone_id ? String(r.milestone_id) : null, version: r.version, implementers: r.implementers })) }
    }, true)
  }
  async function getMilestone (id, namespace) {
    const { rows } = await pool.query(`SELECT ${columns} FROM spec_board_milestones WHERE id=$1 AND namespace=$2`, [id, namespace])
    return rows.length ? milestone(rows[0]) : null
  }
  async function deletedAssignments (namespaces, limit = 100, milestoneId = null) {
    if (!namespaces.length) return []
    const { rows } = await pool.query(`SELECT note_id, namespace, milestone_id, version
      FROM spec_board_planning p WHERE namespace = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM "Notes" n WHERE n.shortid = p.note_id)
        AND ($3::text IS NULL OR ($3 = 'none' AND milestone_id IS NULL) OR milestone_id::text = $3)
      ORDER BY namespace, note_id LIMIT $2`, [namespaces, Math.max(1, Math.min(100, limit)), milestoneId])
    return rows.map(row => ({ noteId: row.note_id, namespace: row.namespace,
      milestoneId: row.milestone_id ? String(row.milestone_id) : null, version: row.version }))
  }
  async function detachDeleted ({ noteId, namespace, expectedVersion, actor }) {
    return tx(async db => {
      const { rows: [current] } = await db.query('SELECT * FROM spec_board_planning WHERE note_id=$1 FOR UPDATE', [noteId])
      if (!current || current.namespace !== namespace || current.version !== expectedVersion) {
        throw fail(409, 'Assignments changed. Reload the planning page.')
      }
      const { rows } = await db.query('SELECT 1 FROM "Notes" WHERE shortid=$1 FOR SHARE', [noteId])
      if (rows.length) throw fail(409, 'The note still exists. Only deleted specs can be detached.')
      const removed = await db.query('DELETE FROM spec_board_implementers WHERE note_id=$1', [noteId])
      const detached = await db.query(`DELETE FROM spec_board_planning WHERE note_id=$1
        AND NOT EXISTS (SELECT 1 FROM "Notes" WHERE shortid=$1)`, [noteId])
      if (!detached.rowCount) throw fail(409, 'The note is available again. Reload the planning page.')
      await db.query(`INSERT INTO spec_board_planning_events (note_id, actor, action, value)
        VALUES ($1,$2,'detach-deleted',$3)`, [noteId, actor, JSON.stringify({ namespace,
        milestoneId: current.milestone_id ? String(current.milestone_id) : null, removedImplementers: removed.rowCount })])
    })
  }
  async function saveMilestone ({ id, namespace, expectedVersion, input, checkpoint }) {
    const args = [namespace, input.title, input.description, input.dueDate, input.state, input.checkpointTag, checkpoint && checkpoint.commit]
    if (!id) {
      const r = await pool.query(`INSERT INTO spec_board_milestones
        (namespace, title, description, due_date, state, checkpoint_tag, checkpoint_commit, checkpoint_linked_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $6::text IS NULL THEN NULL ELSE now() END) RETURNING ${columns}`, args)
      return milestone(r.rows[0])
    }
    const r = await pool.query(`UPDATE spec_board_milestones SET title=$2, description=$3, due_date=$4, state=$5,
      checkpoint_tag=$6, checkpoint_commit=$7,
      checkpoint_linked_at=CASE WHEN $6::text IS NULL THEN NULL WHEN checkpoint_tag=$6 AND checkpoint_commit=$7 THEN checkpoint_linked_at ELSE now() END,
      version=version+1, updated_at=now() WHERE id=$8 AND namespace=$1 AND version=$9 RETURNING ${columns}`,
    [...args, id, expectedVersion])
    if (!r.rows.length) throw fail(409, 'Milestone changed. Reload before saving.')
    return milestone(r.rows[0])
  }
  // Members are unassigned, not deleted: implementers and history stay with
  // the spec, and each release is logged like a manual unassignment.
  async function deleteMilestone ({ id, namespace, expectedVersion, actor }) {
    return tx(async db => {
      const { rows: [current] } = await db.query('SELECT * FROM spec_board_milestones WHERE id=$1 AND namespace=$2 FOR UPDATE', [id, namespace])
      if (!current || current.version !== expectedVersion) throw fail(409, 'Milestone changed. Reload before deleting.')
      const { rows: members } = await db.query(`UPDATE spec_board_planning SET milestone_id=NULL, version=version+1, changed_by=$2, changed_at=now()
        WHERE milestone_id=$1 RETURNING note_id`, [id, actor])
      for (const { note_id: noteId } of members) {
        await db.query('INSERT INTO spec_board_planning_events (note_id, actor, action, value) VALUES ($1,$2,$3,$4)',
          [noteId, actor, 'milestone', JSON.stringify({ namespace, milestoneId: null, userId: null, deletedMilestone: String(id) })])
      }
      await db.query('DELETE FROM spec_board_milestones WHERE id=$1', [id])
      return members.length
    })
  }
  async function saveAssignment ({ noteId, namespace, expectedVersion, action, milestoneId, userId, actor, validate }) {
    return tx(async db => {
      await validate(db)
      await db.query('INSERT INTO spec_board_planning (note_id, namespace) VALUES ($1,$2) ON CONFLICT DO NOTHING', [noteId, namespace])
      const { rows: [current] } = await db.query('SELECT * FROM spec_board_planning WHERE note_id=$1 FOR UPDATE', [noteId])
      if (current.version !== expectedVersion) throw fail(409, 'Assignments changed. Reload before saving.')
      if (action === 'milestone' && milestoneId) {
        const { rows: [target] } = await db.query('SELECT namespace, state FROM spec_board_milestones WHERE id=$1 FOR SHARE', [milestoneId])
        if (!target || target.namespace !== namespace) throw fail(400, 'Milestone belongs to another namespace or does not exist')
        if (target.state !== 'open') throw fail(409, 'Reopen the milestone before assigning work')
      }
      if (current.namespace !== namespace) {
        await db.query('DELETE FROM spec_board_implementers WHERE note_id=$1', [noteId])
        await db.query('UPDATE spec_board_planning SET milestone_id=NULL WHERE note_id=$1', [noteId])
      }
      if (action === 'add-implementer') {
        const { rows } = await db.query('SELECT id FROM "Users" WHERE id::text=$1 FOR SHARE', [userId])
        if (!rows.length) throw fail(400, 'Unknown user')
        await db.query('INSERT INTO spec_board_implementers (note_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [noteId, userId])
      } else if (action === 'remove-implementer') {
        await db.query('DELETE FROM spec_board_implementers WHERE note_id=$1 AND user_id=$2', [noteId, userId])
      } else if (action !== 'milestone') throw fail(400, 'Unknown assignment action')
      await db.query(`UPDATE spec_board_planning SET namespace=$2, milestone_id=CASE WHEN $3 THEN $4 ELSE milestone_id END,
        version=version+1, changed_by=$5, changed_at=now() WHERE note_id=$1`, [noteId, namespace, action === 'milestone', milestoneId || null, actor])
      await db.query(`INSERT INTO spec_board_planning_events (note_id, actor, action, value) VALUES ($1,$2,$3,$4)`,
        [noteId, actor, action, JSON.stringify({ namespace, milestoneId: milestoneId || null, userId: userId || null })])
    })
  }
  async function users (query) {
    const term = query.trim().toLowerCase()
    if (term.length < 2 || term.length > 80) return []
    const { rows } = await pool.query(`SELECT id::text, COALESCE(profile::jsonb->>'username', '') AS login,
      COALESCE(profile::jsonb->>'displayName', profile::jsonb->>'username', 'User') AS name
      FROM "Users" WHERE profile IS NOT NULL AND
      (strpos(lower(COALESCE(profile::jsonb->>'username', '')), $1) > 0 OR strpos(lower(COALESCE(profile::jsonb->>'displayName', '')), $1) > 0)
      ORDER BY lower(COALESCE(profile::jsonb->>'username', '')), id LIMIT 20`, [term])
    return rows
  }
  return { migrate, read, getMilestone, saveMilestone, deleteMilestone, saveAssignment, deletedAssignments, detachDeleted, users }
}
module.exports = { createRoadmapStore }
