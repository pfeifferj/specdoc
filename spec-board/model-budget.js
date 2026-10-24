const { numberConfig } = require('./config')

async function migrateModelBudget (db) {
  await db.query(`CREATE TABLE IF NOT EXISTS spec_board_model_budget (
    scope text NOT NULL, day date NOT NULL DEFAULT CURRENT_DATE,
    calls integer NOT NULL DEFAULT 0, tokens bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, day))`)
  await db.query(`CREATE TABLE IF NOT EXISTS spec_board_model_cooldown (
    scope text PRIMARY KEY, reserved_at timestamptz NOT NULL DEFAULT now())`)
}

function budgetConfig (env = process.env) {
  const read = (name, fallback) => numberConfig(name, fallback, { min: 1, max: 1000000000 }, env)
  return { globalCalls: read('MODEL_DAILY_CALLS', 100), projectCalls: read('MODEL_PROJECT_DAILY_CALLS', 25),
    globalTokens: read('MODEL_DAILY_TOKENS', 2000000), projectTokens: read('MODEL_PROJECT_DAILY_TOKENS', 500000),
    cooldownSeconds: read('MODEL_COOLDOWN_SECONDS', 60), disabled: env.MODEL_AUTOMATION_DISABLED === 'true' }
}

async function reserveModelBudget (db, scopes, tokens, { key, config = budgetConfig() } = {}) {
  if (config.disabled) throw Object.assign(new Error('Model automation is disabled'), { code: 'budget' })
  if (!Number.isSafeInteger(tokens) || tokens < 1) throw new Error('Invalid model token reservation')
  const projects = [...new Set(scopes)].filter(scope => /^[\w.-]+\/[\w.-]+$/.test(scope)).sort()
  if (!projects.length) throw Object.assign(new Error('Model calls require an admitted project scope'), { code: 'budget' })
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('specdoc-model-budget'))")
    await client.query("DELETE FROM spec_board_model_budget WHERE day < CURRENT_DATE - 7")
    await client.query("DELETE FROM spec_board_model_cooldown WHERE reserved_at < now() - interval '1 day'")
    if (key) {
      const { rows } = await client.query(`INSERT INTO spec_board_model_cooldown (scope) VALUES ($1)
        ON CONFLICT (scope) DO UPDATE SET reserved_at=now()
        WHERE spec_board_model_cooldown.reserved_at <= now() - ($2 * interval '1 second') RETURNING scope`, [key, config.cooldownSeconds])
      if (!rows.length) throw Object.assign(new Error('Model trigger is cooling down'), { code: 'budget' })
    }
    for (const scope of ['*', ...projects]) {
      const global = scope === '*'
      await client.query('INSERT INTO spec_board_model_budget (scope) VALUES ($1) ON CONFLICT DO NOTHING', [scope])
      const { rows } = await client.query(`UPDATE spec_board_model_budget SET calls=calls+1, tokens=tokens+$2
        WHERE scope=$1 AND day=CURRENT_DATE AND calls < $3 AND tokens+$2 <= $4 RETURNING scope`,
      [scope, tokens, global ? config.globalCalls : config.projectCalls, global ? config.globalTokens : config.projectTokens])
      if (!rows.length) throw Object.assign(new Error('Daily model budget exhausted'), { code: 'budget' })
    }
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

module.exports = { migrateModelBudget, budgetConfig, reserveModelBudget }
