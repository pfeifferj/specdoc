function createFeedbackStore (pool) {
  const tx = async fn => {
    const db = await pool.connect()
    try {
      await db.query('BEGIN')
      const result = await fn(db)
      await db.query('COMMIT')
      return result
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      db.release()
    }
  }
  const hashOf = evidence => {
    const hash = evidence && (evidence.hash || evidence.sourceHash)
    if (typeof hash !== 'string' || !hash) throw new Error('feedback evidence needs a hash')
    return hash
  }
  const jobOf = row => row && ({
    id: String(row.id), namespace: row.namespace, repo: row.repo, number: row.number,
    manual: row.manual, updatedAt: row.provider_updated_at, nextAt: row.next_at,
    attempts: row.attempts, error: row.error, currentHash: row.current_hash,
    analysisGeneration: row.analysis_generation, available: row.available
  })
  const ensureSettings = async (db, namespace) => db.query(
    'INSERT INTO spec_board_feedback_settings (namespace) VALUES ($1) ON CONFLICT DO NOTHING', [namespace])

  async function migrate () {
    await tx(async db => {
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_feedback_settings (
        namespace text PRIMARY KEY, enabled boolean NOT NULL DEFAULT true,
        generation integer NOT NULL DEFAULT 0, changed_at timestamptz NOT NULL DEFAULT now()
      )`)
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_feedback_scans (
        key text PRIMARY KEY, value jsonb NOT NULL, changed_at timestamptz NOT NULL DEFAULT now()
      )`)
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_feedback_jobs (
        id bigserial PRIMARY KEY, namespace text NOT NULL, repo text NOT NULL, number integer NOT NULL,
        provider_updated_at timestamptz, manual boolean NOT NULL DEFAULT false,
        next_at timestamptz DEFAULT now(), attempts integer NOT NULL DEFAULT 0, error text,
        current_hash text, analysis_generation integer NOT NULL DEFAULT 0,
        available boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (namespace, repo, number), CHECK (number > 0)
      )`)
      await db.query('CREATE INDEX IF NOT EXISTS spec_board_feedback_due ON spec_board_feedback_jobs (next_at)')
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_feedback_evidence (
        job_id bigint NOT NULL REFERENCES spec_board_feedback_jobs(id), hash text NOT NULL,
        payload jsonb, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (job_id, hash)
      )`)
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_feedback_runs (
        job_id bigint NOT NULL REFERENCES spec_board_feedback_jobs(id), hash text NOT NULL,
        generation integer NOT NULL, source_hash text NOT NULL,
        proposal_count integer NOT NULL, payload jsonb, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (job_id, hash, generation)
      )`)
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_feedback_proposals (
        id bigserial PRIMARY KEY, job_id bigint NOT NULL REFERENCES spec_board_feedback_jobs(id),
        target_note text NOT NULL, target_namespace text NOT NULL, group_id text NOT NULL,
        source_hash text NOT NULL, payload jsonb, status text NOT NULL DEFAULT 'pending',
        version integer NOT NULL DEFAULT 1, stale boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(), changed_at timestamptz NOT NULL DEFAULT now(),
        decided_at timestamptz, UNIQUE (job_id, group_id, target_note),
        CHECK (status IN ('pending', 'stale', 'accepted', 'dismissed', 'incorporated'))
      )`)
      await db.query('CREATE INDEX IF NOT EXISTS spec_board_feedback_proposal_namespace ON spec_board_feedback_proposals (target_namespace, changed_at)')
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_feedback_decisions (
        id bigserial PRIMARY KEY, proposal_id bigint REFERENCES spec_board_feedback_proposals(id),
        namespace text NOT NULL, action text NOT NULL, actor jsonb NOT NULL,
        extra jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
      )`)
      await db.query('CREATE INDEX IF NOT EXISTS spec_board_feedback_decision_proposal ON spec_board_feedback_decisions (proposal_id, id)')
    })
  }

  async function settings (namespace) {
    const { rows } = await pool.query('SELECT enabled, generation FROM spec_board_feedback_settings WHERE namespace = $1', [namespace])
    return rows[0] || { enabled: true, generation: 0 }
  }

  async function toggle (namespace, enabled, actor) {
    return tx(async db => {
      await ensureSettings(db, namespace)
      const { rows } = await db.query(`UPDATE spec_board_feedback_settings
        SET enabled = $2, generation = generation + 1, changed_at = now()
        WHERE namespace = $1 RETURNING enabled, generation`, [namespace, !!enabled])
      await db.query(`INSERT INTO spec_board_feedback_decisions (namespace, action, actor, extra)
        VALUES ($1, 'toggle', $2, $3)`, [namespace, JSON.stringify(actor), JSON.stringify(rows[0])])
      return rows[0]
    })
  }

  async function scan (key) {
    const { rows } = await pool.query('SELECT value FROM spec_board_feedback_scans WHERE key = $1', [key])
    return rows.length ? rows[0].value : null
  }

  async function queue (db, candidate) {
    const { namespace, repo, number, manual = false, updatedAt = null } = candidate
    await ensureSettings(db, namespace)
    const { rows } = await db.query(`INSERT INTO spec_board_feedback_jobs
      (namespace, repo, number, manual, provider_updated_at) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (namespace, repo, number) DO UPDATE SET
        manual = spec_board_feedback_jobs.manual OR EXCLUDED.manual,
        analysis_generation = spec_board_feedback_jobs.analysis_generation + CASE WHEN EXCLUDED.manual THEN 1 ELSE 0 END,
        provider_updated_at = GREATEST(spec_board_feedback_jobs.provider_updated_at, EXCLUDED.provider_updated_at),
        next_at = CASE WHEN EXCLUDED.manual OR EXCLUDED.provider_updated_at IS NULL
          OR spec_board_feedback_jobs.provider_updated_at IS NULL
          OR EXCLUDED.provider_updated_at > spec_board_feedback_jobs.provider_updated_at
          THEN LEAST(spec_board_feedback_jobs.next_at, now()) ELSE spec_board_feedback_jobs.next_at END
      RETURNING *`, [namespace, repo, number, manual, updatedAt])
    return jobOf(rows[0])
  }

  async function saveScan (key, value, jobs = []) {
    return tx(async db => {
      for (const job of jobs) await queue(db, job)
      await db.query(`INSERT INTO spec_board_feedback_scans (key, value) VALUES ($1, $2)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, changed_at = now()`, [key, JSON.stringify(value)])
    })
  }

  async function enqueue (namespace, repo, number, manual = false) {
    return tx(db => queue(db, { namespace, repo, number, manual }))
  }

  async function due (limit = 10, namespaces = null) {
    const { rows } = await pool.query(`SELECT * FROM (
      SELECT j.*, row_number() OVER (PARTITION BY j.namespace ORDER BY j.next_at, j.id) AS namespace_rank
      FROM spec_board_feedback_jobs j JOIN spec_board_feedback_settings s USING (namespace)
      WHERE j.next_at <= now() AND (j.manual OR s.enabled)
        AND ($2::text[] IS NULL OR j.namespace = ANY($2))
      ) due ORDER BY CASE WHEN $2::text[] IS NOT NULL THEN array_position($2, namespace)
        ELSE namespace_rank END, next_at, id LIMIT $1`, [Math.max(1, Math.min(100, limit)), namespaces])
    return rows.map(jobOf)
  }

  async function defer (job, ms = 86400000) {
    await pool.query(`UPDATE spec_board_feedback_jobs SET next_at = now() + $2 * interval '1 millisecond'
      WHERE id = $1 AND analysis_generation = $3`, [job.id, Math.max(0, ms), job.analysisGeneration || 0])
  }

  async function finishWith (db, job, mergedAt) {
    const refresh = !mergedAt || Date.parse(mergedAt) + 30 * 86400000 > Date.now()
    await db.query(`UPDATE spec_board_feedback_jobs SET attempts = 0, error = NULL,
      manual = false, next_at = CASE WHEN $2 THEN now() + interval '1 day' ELSE NULL END
      WHERE id = $1 AND analysis_generation = $3`, [job.id, refresh, job.analysisGeneration || 0])
  }

  async function finish (job, mergedAt) {
    await finishWith(pool, job, mergedAt)
  }

  async function waitForMerge (job) {
    await pool.query(`UPDATE spec_board_feedback_jobs SET attempts = 0, error = NULL,
      manual = false, next_at = NULL WHERE id = $1 AND analysis_generation = $2`,
    [job.id, job.analysisGeneration || 0])
  }

  async function fail (job, error) {
    await pool.query(`UPDATE spec_board_feedback_jobs SET attempts = attempts + 1, error = $2,
      next_at = now() + LEAST(86400, 60 * power(2, LEAST(attempts, 10))) * interval '1 second'
      WHERE id = $1 AND analysis_generation = $3`,
    [job.id, String(error && error.message ? error.message : error).slice(0, 1000), job.analysisGeneration || 0])
  }

  async function unavailable (job, reason) {
    await tx(async db => {
      const { rows } = await db.query('SELECT available, analysis_generation FROM spec_board_feedback_jobs WHERE id = $1 FOR UPDATE', [job.id])
      if (!rows.length || rows[0].analysis_generation !== (job.analysisGeneration || 0)) return
      await db.query(`UPDATE spec_board_feedback_jobs SET available = false, error = $2,
        analysis_generation = analysis_generation + CASE WHEN available THEN 1 ELSE 0 END,
        next_at = now() + interval '1 day' WHERE id = $1`, [job.id, String(reason).slice(0, 1000)])
      await db.query(`UPDATE spec_board_feedback_proposals SET stale = true,
        status = CASE WHEN status = 'pending' THEN 'stale' ELSE status END,
        version = version + 1, changed_at = now() WHERE job_id = $1 AND NOT stale`, [job.id])
    })
  }

  async function saveEvidence (job, evidence) {
    const hash = hashOf(evidence)
    const result = await tx(async db => {
      const { rows: locked } = await db.query('SELECT * FROM spec_board_feedback_jobs WHERE id = $1 FOR UPDATE', [job.id])
      if (!locked.length) return null
      if (locked[0].analysis_generation !== (job.analysisGeneration || 0) ||
          (locked[0].current_hash !== (job.currentHash || null) && locked[0].current_hash !== hash)) return null
      await db.query(`INSERT INTO spec_board_feedback_evidence (job_id, hash, payload) VALUES ($1, $2, $3)
        ON CONFLICT (job_id, hash) DO UPDATE SET payload = EXCLUDED.payload
        WHERE spec_board_feedback_evidence.payload IS NULL`, [job.id, hash, JSON.stringify(evidence)])
      if (locked[0].current_hash !== hash) {
        await db.query(`UPDATE spec_board_feedback_proposals SET stale = true,
          status = CASE WHEN status = 'pending' THEN 'stale' ELSE status END,
          version = version + 1, changed_at = now()
          WHERE job_id = $1 AND source_hash <> $2 AND NOT stale`, [job.id, hash])
      }
      const { rows } = await db.query(`UPDATE spec_board_feedback_jobs
        SET current_hash = $2, available = true, error = NULL WHERE id = $1 RETURNING *`, [job.id, hash])
      return jobOf(rows[0])
    })
    if (result) job.currentHash = hash
    return result
  }

  async function analysisExists (jobId, runHash) {
    const { rows } = await pool.query(`SELECT 1 FROM spec_board_feedback_runs r
      JOIN spec_board_feedback_jobs j ON j.id = r.job_id AND j.analysis_generation = r.generation
      WHERE r.job_id = $1 AND r.hash = $2`, [jobId, runHash])
    return !!rows.length
  }

  async function recordAnalysis (job, { runHash, evidence, proposals, settingsGeneration }) {
    const hash = hashOf(evidence)
    return tx(async db => {
      const { rows: options } = await db.query('SELECT * FROM spec_board_feedback_settings WHERE namespace = $1 FOR UPDATE', [job.namespace])
      const option = options[0]
      if (!job.manual && (!option || !option.enabled || option.generation !== settingsGeneration)) {
        return { stored: false, reason: 'settings changed' }
      }
      const { rows: jobs } = await db.query('SELECT * FROM spec_board_feedback_jobs WHERE id = $1 FOR UPDATE', [job.id])
      const current = jobs[0]
      if (!current || !current.available || current.current_hash !== hash || current.analysis_generation !== (job.analysisGeneration || 0)) {
        return { stored: false, reason: 'source or analysis generation changed' }
      }
      const { rows: inserted } = await db.query(`INSERT INTO spec_board_feedback_runs
        (job_id, hash, generation, source_hash, proposal_count, payload) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING RETURNING job_id`, [job.id, runHash, current.analysis_generation, hash, proposals.length, JSON.stringify(proposals)])
      if (!inserted.length) return { stored: false, reason: 'already analyzed' }
      await db.query(`UPDATE spec_board_feedback_proposals SET status = 'stale', stale = true,
        version = version + 1, changed_at = now() WHERE job_id = $1 AND status = 'pending'`, [job.id])
      for (const proposal of proposals) {
        if (proposal.sourceHash !== hash || proposal.targetNamespace !== job.namespace) throw new Error('feedback proposal source or namespace mismatch')
        await db.query(`UPDATE spec_board_feedback_proposals SET stale = true,
          version = version + 1, changed_at = now()
          WHERE job_id = $1 AND group_id = $2 AND target_note = $3 AND NOT stale
            AND status IN ('accepted', 'dismissed', 'incorporated')
            AND (source_hash <> $4 OR payload #>> '{canonical,hash}' IS DISTINCT FROM $5
              OR payload ->> 'editorHash' IS DISTINCT FROM $6)`,
        [job.id, proposal.groupId, proposal.targetNote, hash, proposal.canonical && proposal.canonical.hash, proposal.editorHash])
        await db.query(`INSERT INTO spec_board_feedback_proposals
          (job_id, target_note, target_namespace, group_id, source_hash, payload)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (job_id, group_id, target_note) DO UPDATE SET
            payload = EXCLUDED.payload, source_hash = EXCLUDED.source_hash,
            target_namespace = EXCLUDED.target_namespace, status = 'pending', stale = false,
            version = spec_board_feedback_proposals.version + 1, changed_at = now()
          WHERE spec_board_feedback_proposals.status IN ('pending', 'stale')`,
        [job.id, proposal.targetNote, proposal.targetNamespace, proposal.groupId, hash, JSON.stringify({ ...proposal, analysisHash: runHash })])
      }
      await finishWith(db, job, evidence.mergedAt || (evidence.pr && evidence.pr.merged_at))
      return { stored: true, count: proposals.length }
    })
  }

  const select = `SELECT p.*, row_to_json(j) AS job, e.payload AS evidence,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('action', d.action, 'actor', d.actor,
      'extra', d.extra, 'at', d.created_at) ORDER BY d.id)
      FROM spec_board_feedback_decisions d WHERE d.proposal_id = p.id), '[]'::jsonb) AS audit
    FROM spec_board_feedback_proposals p JOIN spec_board_feedback_jobs j ON j.id = p.job_id
    LEFT JOIN spec_board_feedback_evidence e ON e.job_id = p.job_id AND e.hash = p.source_hash`
  const proposalOf = row => row && ({
    ...(row.payload || {}), id: row.id, version: row.version, status: row.status,
    stale: row.stale, targetNote: row.target_note, targetNamespace: row.target_namespace,
    groupId: row.group_id, sourceHash: row.source_hash,
    createdAt: row.created_at, changedAt: row.changed_at, decidedAt: row.decided_at,
    purged: row.payload == null, job: jobOf(row.job), evidence: row.evidence,
    currentSourceHash: row.job.current_hash, sourceRepo: row.job.repo, sourceNumber: row.job.number,
    audit: row.audit
  })

  async function list (namespaces, limit = 100, { targetNotes = null, before = null } = {}) {
    const { rows } = await pool.query(`${select}
      WHERE p.target_namespace = ANY($1::text[])
        AND ($3::text[] IS NULL OR p.target_note = ANY($3))
        AND ($4::bigint IS NULL OR p.id < $4)
      ORDER BY p.id DESC LIMIT $2`,
    [namespaces, Math.max(1, Math.min(500, limit)), targetNotes, before])
    return rows.map(proposalOf)
  }

  async function get (id) {
    const { rows } = await pool.query(`${select} WHERE p.id = $1`, [id])
    return proposalOf(rows[0]) || null
  }

  async function decide (id, version, action, actor, extra = {}) {
    return tx(async db => {
      const { rows: found } = await db.query('SELECT job_id FROM spec_board_feedback_proposals WHERE id = $1', [id])
      if (!found.length) return null
      const { rows: jobs } = await db.query('SELECT * FROM spec_board_feedback_jobs WHERE id = $1 FOR UPDATE', [found[0].job_id])
      const { rows } = await db.query('SELECT * FROM spec_board_feedback_proposals WHERE id = $1 FOR UPDATE', [id])
      const proposal = rows[0]
      const current = jobs[0]
      if (!proposal || proposal.version !== Number(version)) return null
      const next = action === 'accept' && proposal.status === 'pending' ? 'accepted'
        : action === 'dismiss' && ['pending', 'stale'].includes(proposal.status) ? 'dismissed'
          : action === 'incorporate' && proposal.status === 'accepted' ? 'incorporated'
            : action === 'reconsider' && ['pending', 'accepted', 'dismissed', 'incorporated', 'stale'].includes(proposal.status) ? 'stale' : null
      if (!next) return null
      if (action === 'accept' && (proposal.stale || !current.available || current.current_hash !== proposal.source_hash)) return null
      if (action === 'incorporate' && (!extra.pr || !extra.url)) return null
      await db.query(`UPDATE spec_board_feedback_proposals SET status = $2, version = version + 1,
        stale = CASE WHEN $2 = 'stale' THEN true ELSE stale END,
        decided_at = CASE WHEN $2 = 'stale' THEN NULL ELSE now() END, changed_at = now() WHERE id = $1`, [id, next])
      await db.query(`INSERT INTO spec_board_feedback_decisions (proposal_id, namespace, action, actor, extra)
        VALUES ($1, $2, $3, $4, $5)`, [id, proposal.target_namespace, action, JSON.stringify(actor), JSON.stringify({
        ...extra, proposalVersion: proposal.version, sourceHash: proposal.source_hash,
        analysisHash: proposal.payload && proposal.payload.analysisHash,
        canonicalHash: proposal.payload && proposal.payload.canonical && proposal.payload.canonical.hash
      })])
      if (action === 'reconsider') {
        await db.query(`UPDATE spec_board_feedback_jobs SET analysis_generation = analysis_generation + 1,
          manual = true, next_at = now(), attempts = 0, error = NULL WHERE id = $1`, [current.id])
      }
      const { rows: updated } = await db.query(`${select} WHERE p.id = $1`, [id])
      return proposalOf(updated[0])
    })
  }

  async function status () {
    const { rows } = await pool.query(`SELECT
      (SELECT count(*)::integer FROM spec_board_feedback_jobs WHERE next_at <= now()) AS due,
      (SELECT count(*)::integer FROM spec_board_feedback_jobs WHERE error IS NOT NULL) AS failing,
      (SELECT count(*)::integer FROM spec_board_feedback_proposals WHERE status = 'pending') AS pending,
      (SELECT count(*)::integer FROM spec_board_feedback_proposals WHERE stale) AS stale,
      (SELECT count(*)::integer FROM spec_board_feedback_settings WHERE NOT enabled) AS paused`)
    return rows[0]
  }

  async function problems (namespaces, limit = 50) {
    const { rows } = await pool.query(`SELECT namespace, repo, number, error, next_at
      FROM spec_board_feedback_jobs WHERE error IS NOT NULL AND namespace = ANY($1::text[])
      ORDER BY next_at NULLS LAST, id LIMIT $2`, [namespaces, Math.max(1, Math.min(100, limit))])
    return rows.map(row => ({ namespace: row.namespace, repo: row.repo, number: row.number, error: row.error, nextAt: row.next_at }))
  }

  async function cleanup () {
    return tx(async db => {
      const proposals = await db.query(`UPDATE spec_board_feedback_proposals SET payload = NULL
        WHERE status IN ('dismissed', 'incorporated') AND decided_at < now() - interval '90 days' AND payload IS NOT NULL`)
      const evidence = await db.query(`UPDATE spec_board_feedback_evidence e SET payload = NULL
        WHERE e.payload IS NOT NULL AND e.created_at < now() - interval '90 days'
          AND NOT EXISTS (SELECT 1 FROM spec_board_feedback_proposals p
            WHERE p.job_id = e.job_id AND p.source_hash = e.hash AND p.payload IS NOT NULL)`)
      await db.query(`UPDATE spec_board_feedback_runs r SET payload = NULL
        WHERE r.payload IS NOT NULL AND r.created_at < now() - interval '90 days'
          AND NOT EXISTS (SELECT 1 FROM spec_board_feedback_proposals p
            WHERE p.job_id = r.job_id AND p.source_hash = r.source_hash AND p.payload IS NOT NULL)`)
      await db.query(`UPDATE spec_board_feedback_decisions d SET extra = extra - 'reason'
        WHERE extra ? 'reason' AND EXISTS (SELECT 1 FROM spec_board_feedback_proposals p
          WHERE p.id = d.proposal_id AND p.status IN ('dismissed', 'incorporated')
            AND p.decided_at < now() - interval '90 days')`)
      return { proposals: proposals.rowCount, evidence: evidence.rowCount }
    })
  }

  return { migrate, settings, toggle, scan, saveScan, enqueue, due, defer, finish, waitForMerge, fail, saveEvidence,
    unavailable, analysisExists, recordAnalysis, list, get, decide, status, problems, cleanup }
}

module.exports = { createFeedbackStore }
