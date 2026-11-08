const crypto = require('crypto')

const busy = () => Object.assign(new Error('Documentation work changed or its lease expired.'), { code: 'docs-lease-lost' })
const exhausted = () => Object.assign(new Error('Documentation assessment attempts are exhausted.'), { code: 'docs-assessment-failed' })
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const jobOf = row => row && ({ id: String(row.id), namespace: row.namespace, sourceRepo: row.source_repo,
  targetRepo: row.target_repo, number: row.number, manual: row.manual, phase: row.phase,
  configHash: row.config_hash, source: row.source, baseline: row.baseline, botFingerprint: row.bot_fingerprint,
  token: row.lease_token, attempts: row.attempts, modelAttempts: row.model_attempts, activatedAt: row.activated_at })
const scopeOf = row => ({ namespace: row.namespace, sourceRepo: row.source_repo, targetRepo: row.target_repo,
  activatedAt: row.activated_at, generation: row.generation, cursor: row.cursor, configHash: row.config_hash })
const intentOf = row => row && ({ id: String(row.id), key: row.operation_key, namespace: row.namespace,
  sourceRepo: row.source_repo, number: row.number, mergeSha: row.merge_sha, targetRepo: row.target_repo,
  configHash: row.config_hash, botFingerprint: row.bot_fingerprint, source: row.source,
  baseline: row.baseline, proposal: row.proposal, stage: row.stage, branch: row.branch,
  commit: row.commit_sha, prNumber: row.pr_number, prUrl: row.pr_url, commentId: row.comment_id })

function createDocsFollowupStore (pool) {
  async function tx (work) {
    const db = await pool.connect()
    try {
      await db.query('BEGIN')
      const result = await work(db)
      await db.query('COMMIT')
      return result
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {})
      throw error
    } finally { db.release() }
  }

  async function migrate () {
    await tx(async db => {
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_docs_sources (
        namespace text NOT NULL, source_repo text NOT NULL, target_repo text NOT NULL,
        enabled boolean NOT NULL DEFAULT true, activated_at timestamptz NOT NULL DEFAULT now(),
        generation integer NOT NULL DEFAULT 1, config_hash text NOT NULL, cursor jsonb,
        PRIMARY KEY(namespace,source_repo,target_repo)
      )`)
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_docs_jobs (
        id bigserial PRIMARY KEY, namespace text NOT NULL, source_repo text NOT NULL, target_repo text NOT NULL,
        number integer NOT NULL CHECK(number>0), manual boolean NOT NULL DEFAULT false,
        phase text NOT NULL DEFAULT 'inspect' CHECK(phase IN ('inspect','assess','publish','complete','no-change','stopped')),
        config_hash text NOT NULL, bot_fingerprint text, source jsonb, baseline jsonb,
        next_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0,
        model_attempts integer NOT NULL DEFAULT 0 CHECK(model_attempts BETWEEN 0 AND 3), model_attempt_lease text,
        expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
        error_code text, reason text, lease_token text, lease_until timestamptz, redacted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(namespace,source_repo,target_repo,number)
      )`)
      await db.query('CREATE INDEX IF NOT EXISTS spec_board_docs_jobs_due ON spec_board_docs_jobs(next_at,id)')
      await db.query(`CREATE TABLE IF NOT EXISTS spec_board_docs_intents (
        id bigserial PRIMARY KEY, job_id bigint NOT NULL UNIQUE REFERENCES spec_board_docs_jobs(id),
        operation_key text NOT NULL UNIQUE, namespace text NOT NULL, source_repo text NOT NULL,
        target_repo text NOT NULL, number integer NOT NULL, merge_sha text NOT NULL,
        config_hash text NOT NULL, bot_fingerprint text NOT NULL,
        source jsonb NOT NULL, baseline jsonb NOT NULL, proposal jsonb NOT NULL,
        stage text NOT NULL DEFAULT 'prepared' CHECK(stage IN ('prepared','branch','commit','pr','comment','complete','stopped')),
        branch text, commit_sha text, pr_number integer, pr_url text, comment_id text, redacted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(source_repo,number,merge_sha,target_repo)
      )`)
      await db.query('ALTER TABLE spec_board_docs_jobs ADD COLUMN IF NOT EXISTS redacted_at timestamptz')
      await db.query('ALTER TABLE spec_board_docs_intents ADD COLUMN IF NOT EXISTS redacted_at timestamptz')
      await db.query(`ALTER TABLE spec_board_docs_jobs ADD COLUMN IF NOT EXISTS model_attempts integer NOT NULL
        DEFAULT 0 CHECK(model_attempts BETWEEN 0 AND 3)`)
      await db.query('ALTER TABLE spec_board_docs_jobs ADD COLUMN IF NOT EXISTS model_attempt_lease text')
      await db.query('ALTER TABLE spec_board_docs_jobs ADD COLUMN IF NOT EXISTS expires_at timestamptz')
      await db.query("UPDATE spec_board_docs_jobs SET expires_at=created_at+interval '30 days' WHERE expires_at IS NULL")
      await db.query("ALTER TABLE spec_board_docs_jobs ALTER COLUMN expires_at SET DEFAULT now()+interval '30 days', ALTER COLUMN expires_at SET NOT NULL")
    })
  }

  async function stopDisabled (db) {
    await db.query(`WITH stopped AS (
      UPDATE spec_board_docs_jobs j SET phase='stopped',reason='docs-scope-changed',error_code=NULL,
        lease_token=NULL,lease_until=NULL,model_attempt_lease=NULL,updated_at=now()
      WHERE phase IN ('inspect','assess','publish') AND NOT EXISTS (
        SELECT 1 FROM spec_board_docs_sources s WHERE s.namespace=j.namespace AND s.source_repo=j.source_repo
          AND s.target_repo=j.target_repo AND s.enabled)
      RETURNING id)
      UPDATE spec_board_docs_intents SET stage='stopped',updated_at=now() WHERE job_id IN (SELECT id FROM stopped)`)
  }

  async function reconcileTargets (targets) {
    await tx(async db => {
      await db.query(`UPDATE spec_board_docs_sources s SET enabled=false WHERE enabled AND NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS t(namespace text,"targetRepo" text)
        WHERE t.namespace=s.namespace AND t."targetRepo"=s.target_repo)`,
      [JSON.stringify(targets.map(({ namespace, targetRepo }) => ({ namespace, targetRepo })))])
      await stopDisabled(db)
    })
  }

  async function retireSources ({ namespace, targetRepo, repos }) {
    await tx(async db => {
      await db.query(`UPDATE spec_board_docs_sources SET enabled=false WHERE namespace=$1 AND target_repo=$2
        AND enabled AND NOT(source_repo=ANY($3::text[]))`, [namespace, targetRepo, repos])
      await stopDisabled(db)
    })
  }

  async function syncSources ({ namespace, targetRepo, repos, configHash }) {
    return tx(async db => {
      await db.query(`UPDATE spec_board_docs_sources SET enabled=false
        WHERE namespace=$1 AND target_repo=$2 AND NOT(source_repo=ANY($3::text[]))`, [namespace, targetRepo, repos])
      for (const repo of [...new Set(repos)].sort()) {
        await db.query(`INSERT INTO spec_board_docs_sources(namespace,source_repo,target_repo,config_hash)
          VALUES($1,$2,$3,$4) ON CONFLICT(namespace,source_repo,target_repo) DO UPDATE SET
          activated_at=CASE WHEN spec_board_docs_sources.enabled THEN spec_board_docs_sources.activated_at ELSE now() END,
          cursor=CASE WHEN spec_board_docs_sources.enabled THEN spec_board_docs_sources.cursor ELSE NULL END,
          generation=spec_board_docs_sources.generation+CASE WHEN NOT spec_board_docs_sources.enabled
            OR spec_board_docs_sources.config_hash<>EXCLUDED.config_hash THEN 1 ELSE 0 END,
          enabled=true,config_hash=EXCLUDED.config_hash`, [namespace, repo, targetRepo, configHash])
      }
      await stopDisabled(db)
      return (await db.query(`SELECT * FROM spec_board_docs_sources WHERE namespace=$1 AND target_repo=$2
        AND enabled ORDER BY source_repo`, [namespace, targetRepo])).rows.map(scopeOf)
    })
  }

  async function queue (db, scope, number, manual = false) {
    if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new Error('Invalid documentation source PR number')
    await db.query(`INSERT INTO spec_board_docs_jobs(namespace,source_repo,target_repo,number,manual,config_hash)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(namespace,source_repo,target_repo,number) DO UPDATE SET
      manual=spec_board_docs_jobs.manual OR EXCLUDED.manual`,
    [scope.namespace, scope.sourceRepo, scope.targetRepo, number, manual, scope.configHash])
  }

  async function lockScope (db, scope) {
    const { rows: [row] } = await db.query(`SELECT * FROM spec_board_docs_sources
      WHERE namespace=$1 AND source_repo=$2 AND target_repo=$3 FOR UPDATE`, [scope.namespace, scope.sourceRepo, scope.targetRepo])
    if (!row?.enabled || row.generation !== scope.generation || row.config_hash !== scope.configHash) throw busy()
  }

  async function saveScan (scope, { cursor, items }) {
    return tx(async db => {
      await lockScope(db, scope)
      if (!Array.isArray(items) || items.length > 200 || Buffer.byteLength(JSON.stringify(cursor)) > 200000) throw new Error('Invalid documentation discovery result')
      for (const item of items) await queue(db, scope, item.number)
      await db.query(`UPDATE spec_board_docs_sources SET cursor=$4 WHERE namespace=$1 AND source_repo=$2 AND target_repo=$3`,
        [scope.namespace, scope.sourceRepo, scope.targetRepo, JSON.stringify(cursor)])
    })
  }

  async function enqueue (scope, number) {
    await tx(async db => {
      await lockScope(db, scope)
      await queue(db, scope, number, true)
      await db.query(`UPDATE spec_board_docs_jobs j SET phase='inspect',config_hash=$5,source=NULL,baseline=NULL,
        bot_fingerprint=NULL,error_code=NULL,reason=NULL,attempts=0,model_attempts=0,model_attempt_lease=NULL,
        expires_at=now()+interval '30 days',next_at=now(),redacted_at=NULL,updated_at=now()
        WHERE namespace=$1 AND source_repo=$2 AND target_repo=$3 AND number=$4 AND phase='stopped'
        AND reason IN ('docs-source-changed','docs-target-changed','docs-scope-changed','docs-before-activation','before-activation',
          'docs-assessment-failed','docs-expired','docs-evidence-limit','docs-evidence-unsupported','docs-evidence-mismatch')
        AND (lease_until IS NULL OR lease_until<=now())
        AND NOT EXISTS(SELECT 1 FROM spec_board_docs_intents i WHERE i.job_id=j.id)`,
      [scope.namespace, scope.sourceRepo, scope.targetRepo, number, scope.configHash])
      await db.query(`UPDATE spec_board_docs_jobs j SET phase='inspect',config_hash=$5,source=NULL,baseline=NULL,
        bot_fingerprint=NULL,next_at=now(),error_code=NULL,reason=NULL,attempts=0,model_attempts=0,model_attempt_lease=NULL,
        expires_at=now()+interval '30 days',updated_at=now()
        WHERE namespace=$1 AND source_repo=$2 AND target_repo=$3 AND number=$4 AND phase IN ('inspect','assess')
        AND (lease_until IS NULL OR lease_until<=now())
        AND NOT EXISTS(SELECT 1 FROM spec_board_docs_intents i WHERE i.job_id=j.id)`,
      [scope.namespace, scope.sourceRepo, scope.targetRepo, number, scope.configHash])
    })
  }

  async function claim ({ namespace, targetRepo, sourceRepos, leaseMs = 120000, assessmentLeaseMs = leaseMs }) {
    if ([leaseMs, assessmentLeaseMs].some(value => !Number.isSafeInteger(value) || value < 1000 || value > 600000)) throw new Error('Invalid documentation lease')
    const token = crypto.randomUUID()
    const { rows: [row] } = await pool.query(`WITH due AS (
      SELECT j.id,s.activated_at FROM spec_board_docs_jobs j JOIN spec_board_docs_sources s
        ON s.namespace=j.namespace AND s.source_repo=j.source_repo AND s.target_repo=j.target_repo
      WHERE j.namespace=$1 AND j.target_repo=$2 AND j.source_repo=ANY($3::text[]) AND s.enabled
        AND j.phase IN ('inspect','assess','publish') AND j.next_at<=now() AND j.expires_at>now()
        AND (j.lease_until IS NULL OR j.lease_until<=now()) ORDER BY j.next_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED)
      UPDATE spec_board_docs_jobs j SET lease_token=$4,
        lease_until=now()+(CASE WHEN j.phase='assess' THEN $6::integer ELSE $5::integer END)*interval '1 millisecond'
      FROM due WHERE j.id=due.id RETURNING j.*,due.activated_at`, [namespace, targetRepo, sourceRepos, token, leaseMs, assessmentLeaseMs])
    return jobOf(row)
  }

  async function leased (db, job) {
    const { rows: [row] } = await db.query(`SELECT * FROM spec_board_docs_jobs WHERE id=$1 AND lease_token=$2
      AND lease_until>now() FOR UPDATE`, [job.id, job.token])
    if (!row) throw busy()
    return row
  }

  async function assertLease (job) {
    if (!(await pool.query('SELECT 1 FROM spec_board_docs_jobs WHERE id=$1 AND lease_token=$2 AND lease_until>now()', [job.id, job.token])).rowCount) throw busy()
  }

  async function saveInputs (job, { source, baseline, botFingerprint }) {
    await tx(async db => {
      if ((await leased(db, job)).phase !== 'inspect') throw busy()
      await db.query(`UPDATE spec_board_docs_jobs SET source=$2,baseline=$3,bot_fingerprint=$4,phase='assess',
        error_code=NULL,lease_token=NULL,lease_until=NULL,model_attempt_lease=NULL,updated_at=now() WHERE id=$1`,
      [job.id, JSON.stringify(source), JSON.stringify(baseline), botFingerprint])
    })
  }

  async function beginAssessment (job) {
    return tx(async db => {
      const row = await leased(db, job)
      if (row.phase !== 'assess' || row.model_attempt_lease === job.token) throw busy()
      if (row.model_attempts >= 3) throw exhausted()
      const { rows: [updated] } = await db.query(`UPDATE spec_board_docs_jobs SET model_attempts=model_attempts+1,
        model_attempt_lease=$2,updated_at=now() WHERE id=$1 RETURNING model_attempts`, [job.id, job.token])
      return updated.model_attempts
    })
  }

  async function refundBudgetAttempt (job) {
    return tx(async db => {
      const row = await leased(db, job)
      if (row.phase !== 'assess' || row.model_attempt_lease !== job.token || row.model_attempts < 1) throw busy()
      const { rows: [updated] } = await db.query(`UPDATE spec_board_docs_jobs SET model_attempts=model_attempts-1,
        model_attempt_lease=NULL,updated_at=now() WHERE id=$1 RETURNING model_attempts`, [job.id])
      return updated.model_attempts
    })
  }

  async function assessed (job, assessment) {
    await tx(async db => {
      const row = await leased(db, job)
      if (row.phase !== 'assess') throw busy()
      if (assessment.needed === false) {
        await db.query(`UPDATE spec_board_docs_jobs SET phase='no-change',reason=$2,error_code=NULL,
          lease_token=NULL,lease_until=NULL,model_attempt_lease=NULL,updated_at=now() WHERE id=$1`, [job.id, String(assessment.reason || '').slice(0, 2000)])
        return
      }
      if (assessment.needed !== true || !assessment.proposal || !row.source?.mergeSha || !row.baseline || !row.bot_fingerprint) throw new Error('Invalid documentation assessment')
      const key = hash([row.source_repo, row.number, row.source.mergeSha, row.target_repo])
      const inserted = await db.query(`INSERT INTO spec_board_docs_intents(job_id,operation_key,namespace,source_repo,target_repo,
        number,merge_sha,config_hash,bot_fingerprint,source,baseline,proposal) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(operation_key) DO NOTHING RETURNING id`, [row.id, key, row.namespace, row.source_repo, row.target_repo,
        row.number, row.source.mergeSha, row.config_hash, row.bot_fingerprint, row.source, row.baseline, JSON.stringify(assessment.proposal)])
      await db.query(`UPDATE spec_board_docs_jobs SET phase=$2,reason=$3,error_code=NULL,
        lease_token=NULL,lease_until=NULL,model_attempt_lease=NULL,updated_at=now() WHERE id=$1`,
      [job.id, inserted.rowCount ? 'publish' : 'complete', inserted.rowCount ? null : 'already-proposed'])
    })
  }

  async function intent (job) {
    return intentOf((await pool.query('SELECT * FROM spec_board_docs_intents WHERE job_id=$1', [job.id])).rows[0])
  }

  async function saveStep (job, step) {
    const stages = ['prepared', 'branch', 'commit', 'pr', 'comment', 'complete', 'stopped']
    if (!step || !stages.includes(step.stage) || step.stage === 'prepared') throw new Error('Invalid documentation publication step')
    await tx(async db => {
      if ((await leased(db, job)).phase !== 'publish') throw busy()
      const { rows: [row] } = await db.query('SELECT * FROM spec_board_docs_intents WHERE job_id=$1 FOR UPDATE', [job.id])
      if (!row || stages.indexOf(step.stage) < stages.indexOf(row.stage)) throw new Error('Documentation publication cannot move backwards')
      await db.query(`UPDATE spec_board_docs_intents SET stage=$2,branch=COALESCE($3,branch),commit_sha=COALESCE($4,commit_sha),
        pr_number=COALESCE($5,pr_number),pr_url=COALESCE($6,pr_url),comment_id=COALESCE($7,comment_id),updated_at=now()
        WHERE job_id=$1`, [job.id, step.stage, step.branch || null, step.commit || null, step.prNumber || null, step.prUrl || null, step.commentId == null ? null : String(step.commentId)])
      await db.query(`UPDATE spec_board_docs_jobs SET phase=$2,reason=$3,error_code=NULL,
        lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`,
      [job.id, ['complete', 'stopped'].includes(step.stage) ? step.stage : 'publish', step.reason ? String(step.reason).slice(0, 200) : null])
    })
  }

  async function stop (job, reason, { redact = false } = {}) {
    await tx(async db => {
      await leased(db, job)
      await db.query("UPDATE spec_board_docs_intents SET stage='stopped',updated_at=now() WHERE job_id=$1", [job.id])
      await db.query(`UPDATE spec_board_docs_jobs SET phase='stopped',reason=$2,error_code=NULL,
        lease_token=NULL,lease_until=NULL,model_attempt_lease=NULL,updated_at=now()
        WHERE id=$1`, [job.id, String(reason).slice(0, 200)])
      if (redact) {
        await db.query("UPDATE spec_board_docs_intents SET source='{}',baseline='{}',proposal='{}',redacted_at=now() WHERE job_id=$1", [job.id])
        await db.query('UPDATE spec_board_docs_jobs SET source=NULL,baseline=NULL,redacted_at=now() WHERE id=$1', [job.id])
      }
    })
  }

  async function replan (job, configHash, targetChanged = false) {
    if (!/^[a-f0-9]{64}$/.test(configHash)) throw new Error('Invalid documentation configuration fingerprint')
    await tx(async db => {
      const row = await leased(db, job)
      if (!['inspect', 'assess'].includes(row.phase) || (await db.query('SELECT 1 FROM spec_board_docs_intents WHERE job_id=$1', [job.id])).rowCount) throw busy()
      const delay = targetChanged ? Math.min(3600000, 60000 * 2 ** Math.min(row.attempts, 6)) : 0
      await db.query(`UPDATE spec_board_docs_jobs SET phase='inspect',config_hash=$2,source=NULL,baseline=NULL,bot_fingerprint=NULL,
        error_code=$3,reason=NULL,attempts=$4,next_at=now()+$5*interval '1 millisecond',
        lease_token=NULL,lease_until=NULL,model_attempt_lease=NULL,updated_at=now() WHERE id=$1`,
      [job.id, configHash, targetChanged ? 'docs-target-changed' : null, targetChanged ? row.attempts + 1 : 0, delay])
    })
  }

  async function cleanup () {
    return tx(async db => {
      await db.query(`WITH expired AS (
        SELECT id FROM spec_board_docs_jobs WHERE phase IN ('inspect','assess','publish')
          AND (expires_at<=now() OR (phase='assess' AND model_attempts>=3))
          AND (lease_until IS NULL OR lease_until<=now()) ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED),
        stopped AS (
          UPDATE spec_board_docs_jobs j SET phase='stopped',
            reason=CASE WHEN expires_at<=now() THEN 'docs-expired' ELSE 'docs-assessment-failed' END,
            error_code=NULL,lease_token=NULL,lease_until=NULL,model_attempt_lease=NULL,updated_at=now()
          FROM expired WHERE j.id=expired.id RETURNING j.id)
        UPDATE spec_board_docs_intents SET stage='stopped',updated_at=now() WHERE job_id IN (SELECT id FROM stopped)`)
      const { rows } = await db.query(`SELECT id FROM spec_board_docs_jobs WHERE phase IN ('complete','no-change','stopped')
        AND updated_at<now()-interval '90 days' AND redacted_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`)
      const ids = rows.map(row => row.id)
      if (!ids.length) return 0
      await db.query(`UPDATE spec_board_docs_intents SET source='{}',baseline='{}',proposal='{}',redacted_at=now()
        WHERE job_id=ANY($1::bigint[])`, [ids])
      await db.query(`UPDATE spec_board_docs_jobs SET source=NULL,baseline=NULL,
        reason=CASE WHEN phase='stopped' THEN reason ELSE NULL END,redacted_at=now()
        WHERE id=ANY($1::bigint[])`, [ids])
      return ids.length
    })
  }

  async function defer (job, error) {
    const code = typeof error?.code === 'string' && /^[a-z0-9_-]{1,80}$/i.test(error.code) ? error.code : 'unavailable'
    const delay = Math.min(3600000, 60000 * 2 ** Math.min(job.attempts || 0, 6))
    const retryAt = Number.isSafeInteger(error?.retryAt) ? Math.min(Date.now() + 86400000, error.retryAt) : 0
    await tx(async db => {
      await leased(db, job)
      await db.query(`UPDATE spec_board_docs_jobs SET error_code=$2,attempts=attempts+1,
        next_at=GREATEST(now()+$3*interval '1 millisecond',to_timestamp($4::double precision/1000)),
        lease_token=NULL,lease_until=NULL,model_attempt_lease=NULL,updated_at=now() WHERE id=$1`, [job.id, code, delay, retryAt])
    })
  }

  async function status () {
    const { rows: [row] } = await pool.query(`SELECT count(*) FILTER(WHERE phase IN ('inspect','assess','publish'))::integer AS pending,
      count(*) FILTER(WHERE error_code IS NOT NULL AND phase IN ('inspect','assess','publish'))::integer AS deferred,
      count(*) FILTER(WHERE phase='no-change')::integer AS unchanged,
      count(*) FILTER(WHERE phase='complete')::integer AS completed,
      count(*) FILTER(WHERE phase='stopped')::integer AS stopped FROM spec_board_docs_jobs`)
    return row
  }

  return { migrate, reconcileTargets, retireSources, syncSources, saveScan, enqueue, claim, assertLease, saveInputs,
    beginAssessment, refundBudgetAttempt, assessed, intent, saveStep, stop, replan, cleanup, defer, status }
}

module.exports = { createDocsFollowupStore }
