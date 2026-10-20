const MAX_CANDIDATES = 16
const MAX_BATCH_SIZE = 8
const MAX_TIMEOUT = 60000
const MAX_TEXT = 6000
const MAX_TASK = 2000
const MAX_HEADING = 500
const MAX_RESPONSE = 256 * 1024

function configuredInteger (name, fallback, min, max) {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

async function readJsonBounded (response, maxBytes = MAX_RESPONSE) {
  const declared = Number(response.headers.get('content-length'))
  if (declared > maxBytes) {
    await response.body?.cancel()
    throw new Error('response exceeds byte limit')
  }
  if (!response.body) throw new Error('empty response')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error('response exceeds byte limit')
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function endpoint (value) {
  const url = new URL(value)
  const local = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
  if (!['http:', 'https:'].includes(url.protocol) || !local || url.username || url.password || url.search || url.hash) {
    throw new Error('URL must use HTTP(S) on loopback without credentials, query, or fragment')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/systemone/batch`
  return url
}

async function rerank (task, candidates, {
  url = process.env.SPECDOC_LAYA_URL,
  model = process.env.SPECDOC_LAYA_MODEL || 'english',
  signal,
  timeout = configuredInteger('SPECDOC_LAYA_TIMEOUT_MS', 2000, 100, MAX_TIMEOUT),
  maxCandidates = configuredInteger('SPECDOC_LAYA_MAX_CANDIDATES', MAX_CANDIDATES, 1, MAX_CANDIDATES),
  batchSize = configuredInteger('SPECDOC_LAYA_BATCH_SIZE', MAX_BATCH_SIZE, 1, MAX_BATCH_SIZE)
} = {}) {
  const fallback = reason => ({ scores: null, model: null, reason })
  if (!url) return fallback('disabled')
  let target
  try { target = endpoint(url) } catch { return fallback('invalid local Laya URL') }
  if (typeof model !== 'string' || !model.trim() || model.length > 200) return fallback('invalid model')
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > MAX_TIMEOUT) return fallback('invalid timeout')
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > MAX_CANDIDATES) return fallback('invalid candidate limit')
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) return fallback('invalid batch size')
  if (typeof task !== 'string' || !task.trim() || task.length > MAX_TASK) return fallback('task exceeds scoring limits')
  if (!Array.isArray(candidates)) return fallback('invalid candidates')
  const selected = []
  const ids = new Set()
  for (const candidate of candidates) {
    if (selected.length === maxCandidates) break
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id || candidate.id.length > MAX_HEADING ||
        typeof candidate.text !== 'string' || !candidate.text.trim() || candidate.text.length > MAX_TEXT ||
        (candidate.heading !== undefined && (typeof candidate.heading !== 'string' || candidate.heading.length > MAX_HEADING))) continue
    if (ids.has(candidate.id)) return fallback('duplicate candidate id')
    ids.add(candidate.id)
    selected.push(candidate)
  }
  if (!selected.length) return fallback('no complete candidates within scoring limits')
  if (signal?.aborted) return fallback('cancelled')

  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, timeout)
  const started = performance.now()
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      redirect: 'error',
      signal: controller.signal,
      body: JSON.stringify({
        model,
        states: selected.map(candidate => `Task:\n${task}\n\nSection: ${candidate.heading || candidate.id}\n${candidate.text}`),
        questions: { relevance: { type: 'noul', instructions: 'Does this section contain information useful for the task?' } },
        max_len: 512,
        batch_size: batchSize
      })
    })
    if (!response.ok) {
      await response.body?.cancel()
      return fallback(`HTTP ${response.status}`)
    }
    const result = await readJsonBounded(response)
    if (!Array.isArray(result?.results) || result.results.length !== selected.length) return fallback('invalid result count')
    const scores = new Map()
    for (let i = 0; i < selected.length; i++) {
      const row = result.results[i]
      const usage = row?.usage
      const answer = row?.answers?.relevance
      if (!usage || usage.truncated !== false ||
          (usage.state_tokens_dropped !== undefined && usage.state_tokens_dropped !== 0) ||
          (usage.truncated_questions !== undefined && (!Array.isArray(usage.truncated_questions) || usage.truncated_questions.length !== 0))) {
        return fallback('model input was truncated or completeness was not reported')
      }
      if (answer?.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
        return fallback('invalid relevance probability')
      }
      scores.set(selected[i].id, answer.noul)
    }
    return { scores, model, reason: `scored ${selected.length} candidates; ${candidates.length - selected.length} unscored; elapsed ${Math.round(performance.now() - started)} ms; batch_size=${batchSize}` }
  } catch {
    return fallback(controller.signal.aborted
      ? signal?.aborted ? 'cancelled' : `timeout (${timeout} ms budget; ${selected.length} candidates; batch_size=${batchSize})`
      : 'Laya unavailable or invalid response')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

module.exports = { rerank, readJsonBounded }
