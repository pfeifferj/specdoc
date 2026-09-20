const { createFeedbackGitHub } = require('./feedback-github')
const { analyzeFeedback, feedbackRunHash, canManageFeedback } = require('./feedback')
const { feedbackSettings } = require('./feedback-ui')
const { implementsRefs } = require('./refs')

const DAY = 86400000
const repoName = value => typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value)
const list = value => (Array.isArray(value) ? value : String(value || '').split(',')).map(v => String(v).trim()).filter(Boolean)

function createFeedbackService (deps) {
  const { store, gh, namespaces, roles, getSpecs, getState, getBots, hashBody, publicSpec } = deps
  let turn = 0
  let health = { pending: 0 }
  const discoveryErrors = new Map()
  const provider = (progress = false) => (deps.createProvider || createFeedbackGitHub)(async (...args) => {
    try { return await gh(...args) } finally { if (progress && deps.progress) deps.progress() }
  }, { maxCalls: 64 })
  const repos = (ns, r) => list(r['implementation-repos']).length ? list(r['implementation-repos']).filter(repoName) : [ns]

  async function configuration (ns, bots, force = false) {
    if (!namespaces.includes(ns)) return null
    const r = await roles(ns, force)
    if (!r || typeof r['feedback-bot'] !== 'string') return null
    const bot = bots.find(b => b.name === r['feedback-bot'] && b.namespaces.includes(ns))
    if (!bot) return null
    return { roles: r, bot, settings: await store.settings(ns), repos: repos(ns, r) }
  }

  function targetsFor (evidence, ns, specs, state) {
    const linked = new Set(evidence.links.filter(r => r.ns === ns).map(r => r.n))
    const eligible = specs.filter(s => {
      const st = state.get(s.id)
      return st && (st.namespace || s.namespace) === ns && st.spec_path && st.pr_state === 'merged' &&
        !st.superseded_at && publicSpec(s) && (s.topLevel ? s.statusIdx >= 3 : linked.has(st.pr_number))
    })
    return eligible.some(s => !s.topLevel) ? eligible : []
  }

  async function targetsWithBodies (api, evidence, ns, specs, state) {
    const targets = []
    let commit
    for (const s of targetsFor(evidence, ns, specs, state)) {
      const canonical = await api.baseline(ns, state.get(s.id).spec_path, commit)
      commit = canonical.commit
      targets.push({ id: s.id, namespace: ns, title: s.title, topLevel: s.topLevel,
        canonical, editorHash: hashBody(s) })
    }
    return targets
  }

  function isSpecPr (repo, number, state) {
    return [...state.values()].some(s => s.namespace === repo && (s.pr_number === number || s.revision_pr === number))
  }

  async function tick ({ specs, state, bots, modelCall }) {
    const api = provider(true)
    const configs = new Map()
    for (const ns of namespaces) {
      const config = await configuration(ns, bots)
      if (config) configs.set(ns, config)
      if (deps.progress) deps.progress()
    }
    const scans = [...configs].flatMap(([ns, c]) => c.settings.enabled ? c.repos.map(repo => ({ ns, repo })) : [])
    const activeScans = new Set(scans.map(({ ns, repo }) => `${ns}:${repo}`))
    for (const key of discoveryErrors.keys()) if (!activeScans.has(key)) discoveryErrors.delete(key)
    if (scans.length) {
      const { ns, repo } = scans[turn % scans.length]
      const key = `${ns}:${repo}`
      try {
        const settings = await store.settings(ns)
        if (settings.enabled) {
          const saved = await store.scan(key)
          if (!saved || (saved.complete && (!Number(saved.reconcileAt) || Number(saved.reconcileAt) <= Date.now()))) await api.preflight(repo)
          const result = await api.discover(repo, saved)
          const jobs = result.items.filter(p => !isSpecPr(repo, p.number, state)).filter(p => {
            return implementsRefs(p.body || '', repo).some(r => r.ns === ns)
          }).map(p => ({ namespace: ns, repo, number: p.number, updatedAt: p.updatedAt }))
          if ((await store.settings(ns)).enabled) await store.saveScan(key, result.scan, jobs)
          discoveryErrors.delete(key)
        }
      } catch (e) { discoveryErrors.set(key, e.code || 'unavailable') }
    }
    health = { ...health, discoveryFailures: discoveryErrors.size, discoveryError: discoveryErrors.values().next().value || null }
    const order = namespaces.slice(turn % Math.max(1, namespaces.length)).concat(namespaces.slice(0, turn % Math.max(1, namespaces.length)))
    const due = await store.due(1, order.filter(ns => configs.has(ns)))
    turn++
    due.sort((a, b) => order.indexOf(a.namespace) - order.indexOf(b.namespace))
    const job = due.find(j => configs.has(j.namespace))
    if (job) {
      try {
        const config = configs.get(job.namespace)
        if (!config.repos.includes(job.repo) || isSpecPr(job.repo, job.number, state)) throw Object.assign(new Error('source is no longer eligible'), { code: 'ineligible' })
        if (!job.manual && !config.settings.enabled) return
        const beforeEvidence = api.calls
        const evidence = await api.evidence(job.repo, job.number)
        const evidenceCalls = api.calls - beforeEvidence
        if (await store.saveEvidence(job, evidence) === null) throw new Error('source changed while collecting review evidence')
        if (!job.manual && Date.now() - Date.parse(evidence.mergedAt) > 30 * DAY) {
          await store.finish(job, evidence.mergedAt)
        } else {
          const targets = await targetsWithBodies(api, evidence, job.namespace, specs, state)
          const runHash = feedbackRunHash(evidence, targets, config.bot)
          if (await store.analysisExists(job.id, runHash)) {
            await store.finish(job, evidence.mergedAt)
          } else {
            const enabled = await store.settings(job.namespace)
            if (!job.manual && (!enabled.enabled || enabled.generation !== config.settings.generation)) return
            if (Number.isFinite(api.remaining) && api.remaining < evidenceCalls + 3 + targets.length) {
              throw Object.assign(new Error('too many review pages or target specs to validate within the feedback request budget'), { code: 'incomplete' })
            }
            const proposals = targets.length ? await analyzeFeedback(modelCall, config.bot, evidence, targets) : []
            const currentConfig = await configuration(job.namespace, await getBots(), true)
            if (!currentConfig || feedbackRunHash(evidence, targets, currentConfig.bot) !== runHash || !currentConfig.repos.includes(job.repo)) throw new Error('feedback configuration changed during analysis')
            if (!await api.publicRepo(job.repo, true)) throw Object.assign(new Error('source is no longer public'), { code: 'ineligible' })
            if (!await api.publicRepo(job.namespace, true)) throw Object.assign(new Error('spec repository is no longer public'), { code: 'ineligible' })
            const currentSpecs = await getSpecs()
            const currentState = await getState()
            const eligible = new Set(targetsFor(evidence, job.namespace, currentSpecs, currentState).map(s => s.id))
            if (proposals.some(p => !eligible.has(p.targetNote))) throw new Error('target is no longer eligible')
            const latest = await api.evidence(job.repo, job.number)
            if (latest.hash !== evidence.hash) {
              if (await store.saveEvidence(job, latest) === null) throw new Error('source changed while validating review evidence')
              throw new Error('review discussion changed during analysis')
            }
            let commit
            for (const target of targets) {
              const spec = currentSpecs.find(s => s.id === target.id)
              const canonical = await api.baseline(job.namespace, target.canonical.path, commit)
              commit = canonical.commit
              if (!spec || !publicSpec(spec) || canonical.hash !== target.canonical.hash || hashBody(spec) !== target.editorHash) throw new Error('spec changed during analysis')
            }
            await store.recordAnalysis(job, { runHash, evidence, proposals, settingsGeneration: config.settings.generation })
          }
        }
      } catch (e) {
        if (e.code === 'unmerged') await store.waitForMerge(job)
        else if (e.code === 'budget') await store.defer(job, 60000)
        else {
          if (['ineligible', 'inaccessible'].includes(e.code)) await store.unavailable(job, e.message)
          await store.fail(job, e)
        }
      }
    }
    // Queued proposals land in their notes as suggestions once the note is
    // quiet and closed; a busy note waits for a later tick.
    if (deps.applyProposals) {
      const byNote = new Map()
      for (const p of await store.queued()) byNote.set(p.targetNote, [...(byNote.get(p.targetNote) || []), p])
      let budget = 3
      for (const [noteId, group] of byNote) {
        if (budget <= 0) break
        const ids = group.map(p => p.id)
        const spec = specs.find(sp => sp.id === noteId)
        const st = state.get(noteId) || {}
        const namespace = st.namespace || (spec && spec.namespace)
        const config = spec && configs.get(namespace)
        if (!spec || st.superseded_at || !namespaces.includes(namespace) || !publicSpec(spec) ||
            group.some(p => p.targetNamespace !== namespace)) { await store.markPlaced(ids, 'unplaced'); continue }
        if (!config || !config.settings.enabled) continue
        try {
          const result = await deps.applyProposals(spec, group, config.bot.name)
          if (!result) continue
          budget--
          await store.markPlaced(result.placed, 'placed')
          await store.markPlaced(result.commented, 'commented')
        } catch (e) {
          if (![409, 412].includes(e.status)) console.error(`feedback [${noteId}]:`, e.message)
        }
      }
    }
    await store.cleanup()
    health = { ...health, ...await store.status() }
  }

  async function settingsHtml (s) {
    const bots = await getBots()
    const rows = []
    for (const ns of namespaces) {
      const r = await roles(ns)
      if (!canManageFeedback(s, r, deps.isAdmin(s))) continue
      const config = await configuration(ns, bots)
      rows.push({ namespace: ns, enabled: (await store.settings(ns)).enabled,
        configured: !!config, manageable: true })
    }
    return feedbackSettings(deps.csrfToken(s.login), rows)
  }

  async function post (req, res, url, s) {
    const form = new URLSearchParams(await deps.readBody(req, 10000))
    if (form.get('csrf') !== deps.csrfToken(s.login)) { res.writeHead(403).end('bad csrf'); return }
    const ns = form.get('namespace')
    if (!namespaces.includes(ns)) { res.writeHead(404).end('unknown namespace'); return }
    const r = await roles(ns, true)
    if (!canManageFeedback(s, r, deps.isAdmin(s))) { res.writeHead(403).end('not allowed to manage this namespace'); return }
    await store.toggle(ns, form.get('enabled') === 'on', s.login)
    deps.redirect(res, '/settings?saved=1')
  }

  async function handle (req, res, url) {
    const s = deps.session(req)
    if (!s) {
      if (req.method === 'GET') deps.startLogin(req, res, '/settings')
      else res.writeHead(401).end('not signed in')
      return
    }
    try {
      if (req.method === 'POST' && url.pathname === '/feedback/settings') await post(req, res, url, s)
      else if (req.method === 'GET') deps.redirect(res, '/settings')
      else res.writeHead(405).end('method not allowed')
    } catch (e) {
      console.warn('feedback request:', e.code || 'unavailable', e.message)
      res.writeHead(['invalid', 'ineligible', 'unmerged'].includes(e.code) ? 400 : 503).end('feedback unavailable; retry after the source or configuration is accessible')
    }
  }

  return { tick, handle, settingsHtml, targetsFor, get status () { return health } }
}

module.exports = { createFeedbackService }
