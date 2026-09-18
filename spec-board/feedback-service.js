const { createFeedbackGitHub } = require('./feedback-github')
const { analyzeFeedback, feedbackRunHash, canTriage, canManageFeedback } = require('./feedback')
const { feedbackPage, feedbackSettings } = require('./feedback-ui')
const { implementsRefs } = require('./refs')
const { wordDiff, diffText } = require('./prosediff')

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

  async function context (refresh = false) {
    const specs = await getSpecs()
    const state = await getState()
    const byId = new Map(specs.map(s => [s.id, { ...s, namespace: (state.get(s.id) || {}).namespace || s.namespace }]))
    const permission = new Map()
    return { specs, state, byId, roles: async ns => {
      if (!permission.has(ns)) permission.set(ns, await roles(ns, refresh))
      return permission.get(ns)
    } }
  }

  async function visible (s, p, ctx, api) {
    if (p.job.available === false) return false
    const target = ctx.byId.get(p.targetNote)
    if (!target || !publicSpec(target) || target.namespace !== p.targetNamespace || !namespaces.includes(target.namespace)) return false
    const r = await ctx.roles(target.namespace)
    if (!r || !canTriage(s, target, r) || !repos(target.namespace, r).includes(p.job.repo)) return false
    try { return await api.publicRepo(p.job.repo) && await api.publicRepo(p.targetNamespace) } catch { return false }
  }

  async function page (req, res, url, s) {
    const ctx = await context()
    const api = provider()
    const selected = url.searchParams.get('namespace')
    const before = url.searchParams.get('before')
    if (before !== null && (!/^[1-9]\d{0,18}$/.test(before) || BigInt(before) > 9223372036854775807n)) {
      res.writeHead(400).end('invalid proposal cursor')
      return
    }
    const scope = selected && namespaces.includes(selected) ? [selected] : namespaces
    const targetNotes = []
    const allowed = new Set()
    for (const sp of ctx.byId.values()) {
      if (!namespaces.includes(sp.namespace) || !publicSpec(sp)) continue
      const r = await ctx.roles(sp.namespace)
      if (r && canTriage(s, sp, r)) {
        allowed.add(sp.namespace)
        if (scope.includes(sp.namespace)) targetNotes.push(sp.id)
      }
    }
    const proposals = []
    const rows = await store.list(scope, 101, { targetNotes, before })
    const pageRows = rows.slice(0, 100)
    const diffs = new Map()
    for (const p of pageRows) {
      if (!await visible(s, p, ctx, api)) continue
      const target = ctx.byId.get(p.targetNote)
      const editorHash = hashBody(target)
      let editorDiff = ''
      if (p.canonical && p.canonical.hash !== editorHash && deps.getBody) {
        const key = `${target.id}:${p.canonical.hash}`
        if (!diffs.has(key)) diffs.set(key, diffText(wordDiff(p.canonical.body, deps.getBody(target))))
        editorDiff = diffs.get(key)
      }
      proposals.push({ ...p, noteUrl: target.url, title: target.title,
        editorChanged: p.editorHash !== editorHash, editorDiff })
    }
    let nextUrl = ''
    if (rows.length > pageRows.length) {
      const query = new URLSearchParams({ before: String(pageRows[pageRows.length - 1].id) })
      if (selected && namespaces.includes(selected)) query.set('namespace', selected)
      nextUrl = '/feedback?' + query
    }
    const problems = []
    for (const problem of await store.problems([...allowed])) {
      try {
        const r = await ctx.roles(problem.namespace)
        if (repos(problem.namespace, r).includes(problem.repo) && await api.publicRepo(problem.repo) && await api.publicRepo(problem.namespace)) {
          const settings = await store.settings(problem.namespace)
          problems.push({ ...problem, nextAt: settings.enabled ? problem.nextAt : null })
        }
      } catch { /* An inaccessible source must not expose its saved diagnostics. */ }
    }
    const html = feedbackPage({ login: s.login, csrf: deps.csrfToken(s.login), proposals, namespaces: [...allowed], nextUrl,
      problems, notice: url.searchParams.has('saved') ? 'Saved.' : '', error: '' })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' })
    res.end(deps.basicPage('Spec amendment proposals', html))
  }

  async function post (req, res, url, s) {
    const form = new URLSearchParams(await deps.readBody(req, 10000))
    if (form.get('csrf') !== deps.csrfToken(s.login)) { res.writeHead(403).end('bad csrf'); return }
    const ns = form.get('namespace')
    if (url.pathname === '/feedback/settings') {
      if (!namespaces.includes(ns)) { res.writeHead(404).end('unknown namespace'); return }
      const r = await roles(ns, true)
      if (!canManageFeedback(s, r, deps.isAdmin(s))) { res.writeHead(403).end('not allowed to manage this namespace'); return }
      await store.toggle(ns, form.get('enabled') === 'on', s.login)
      deps.redirect(res, '/settings?saved=1')
      return
    }
    const ctx = await context(true)
    const api = provider()
    const action = form.get('action')
    if (action === 'import') {
      const repo = form.get('repo')
      const number = Number(form.get('number'))
      const config = await configuration(ns, await getBots(), true)
      if (!config || !config.repos.includes(repo) || !Number.isSafeInteger(number) || number < 1) { res.writeHead(400).end('invalid implementation PR'); return }
      if (!ctx.specs.some(sp => ((ctx.state.get(sp.id) || {}).namespace || sp.namespace) === ns && canTriage(s, sp, config.roles))) { res.writeHead(403).end('not allowed to import for this namespace'); return }
      if (isSpecPr(repo, number, ctx.state)) { res.writeHead(400).end('a spec PR cannot provide implementation feedback'); return }
      const evidence = await api.evidence(repo, number)
      const targets = targetsFor(evidence, ns, ctx.specs, ctx.state)
      if (!targets.some(sp => !sp.topLevel && canTriage(s, sp, config.roles))) { res.writeHead(400).end('no authorized linked spec'); return }
      await store.enqueue(ns, repo, number, true)
    } else {
      const id = form.get('id')
      const version = Number(form.get('version'))
      const p = await store.get(id)
      if (!p || !await visible(s, p, ctx, api)) { res.writeHead(404).end('proposal unavailable'); return }
      const extra = {}
      if (action === 'dismiss') extra.reason = (form.get('reason') || '').slice(0, 1000)
      if (action === 'accept') {
        const target = ctx.byId.get(p.targetNote)
        const st = ctx.state.get(target.id)
        if (!st || st.superseded_at) { res.writeHead(409).end('spec was retired; reconsider this proposal'); return }
        const evidence = await api.evidence(p.job.repo, p.job.number)
        if (await store.saveEvidence(p.job, evidence) === null) {
          res.writeHead(409).end('review evidence changed; reload before deciding')
          return
        }
        const canonical = await api.baseline(p.targetNamespace, st.spec_path)
        if (evidence.hash !== p.sourceHash || canonical.hash !== p.canonical.hash || hashBody(target) !== p.editorHash ||
            !targetsFor(evidence, p.targetNamespace, ctx.specs, ctx.state).some(t => t.id === p.targetNote)) {
          res.writeHead(409).end('source or spec changed; reconsider the proposal before accepting')
          return
        }
      } else if (action === 'incorporate') {
        const number = Number(form.get('number'))
        if (form.get('repo') !== p.targetNamespace || !await api.mergedRevision(p.targetNamespace, number, p.canonical.path)) {
          res.writeHead(400).end('provide a merged revision PR that changes this spec')
          return
        }
        extra.pr = number
        extra.url = `https://github.com/${p.targetNamespace}/pull/${number}`
      } else if (!['dismiss', 'reconsider'].includes(action)) {
        res.writeHead(400).end('unknown action')
        return
      }
      if (action === 'reconsider' && !await configuration(p.targetNamespace, await getBots(), true)) {
        res.writeHead(409).end('configure an enabled feedback bot for this namespace before reconsidering')
        return
      }
      const currentRoles = await roles(p.targetNamespace, true)
      const currentSpec = (await getSpecs()).find(sp => sp.id === p.targetNote)
      const currentState = (await getState()).get(p.targetNote)
      if (!currentSpec || !publicSpec(currentSpec) || !currentRoles || !canTriage(s, currentSpec, currentRoles) ||
          !currentState || (currentState.namespace || currentSpec.namespace) !== p.targetNamespace ||
          !repos(p.targetNamespace, currentRoles).includes(p.job.repo) ||
          !await api.publicRepo(p.job.repo, true) || !await api.publicRepo(p.targetNamespace, true)) {
        res.writeHead(403).end('proposal permission changed')
        return
      }
      if (action === 'accept' && hashBody(currentSpec) !== p.editorHash) {
        res.writeHead(409).end('spec changed; reconsider the proposal before accepting')
        return
      }
      const updated = await store.decide(id, version, action, s.login, extra)
      if (!updated) { res.writeHead(409).end('proposal changed; reload before deciding'); return }
    }
    deps.redirect(res, '/feedback?saved=1')
  }

  async function handle (req, res, url) {
    const s = deps.session(req)
    if (!s) {
      if (req.method === 'GET') deps.startLogin(req, res, '/feedback')
      else res.writeHead(401).end('not signed in')
      return
    }
    try {
      if (req.method === 'GET' && url.pathname === '/feedback') await page(req, res, url, s)
      else if (req.method === 'POST') await post(req, res, url, s)
      else res.writeHead(405).end('method not allowed')
    } catch (e) {
      console.warn('feedback request:', e.code || 'unavailable')
      res.writeHead(['invalid', 'ineligible', 'unmerged'].includes(e.code) ? 400 : 503).end('feedback unavailable; retry after the source or configuration is accessible')
    }
  }

  return { tick, handle, settingsHtml, targetsFor, get status () { return health } }
}

module.exports = { createFeedbackService }
