'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { request, mutation, credential, originFor, digest, UUID } = require('./client')
const { usage, OperationError } = require('./errors')
async function input (file, context) {
  if (!file) throw usage('--body-file is required; use - to read stdin')
  let bytes
  if (file === '-') {
    const chunks = []; let length = 0
    for await (const chunk of context.stdin) {
      length += Buffer.byteLength(chunk)
      if (length > 64 * 1024 * 1024) throw usage('Input exceeds 64 MiB')
      chunks.push(Buffer.from(chunk))
    }
    bytes = Buffer.concat(chunks)
  } else {
    if (fs.statSync(file).size > 64 * 1024 * 1024) throw usage('Input exceeds 64 MiB')
    bytes = fs.readFileSync(file)
  }
  let value
  try { value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { throw usage('Input must be valid UTF-8') }
  if (value.includes('\0')) throw usage('Content cannot contain NUL')
  return value.replace(/\r\n?/g, '\n')
}
function refIdentifier (value, config, kind) {
  if (!value || value.length > 1024) throw usage('A reference is required')
  if (/^https?:\/\//i.test(value)) {
    let url
    try { url = new URL(value) } catch { throw usage('Invalid reference URL') }
    const allowed = kind === 'author' ? [config.editorOrigin] : [config.editorOrigin, config.boardOrigin]
    if (!allowed.includes(url.origin) || url.username || url.password) throw usage('Reference URL does not belong to the configured service origins')
    const parts = url.pathname.split('/').filter(Boolean)
    if (url.origin === config.boardOrigin && parts[0] === 'spec') parts.shift()
    if (parts.length !== 1 || url.search) throw usage('Reference URL must identify one note')
    try { return decodeURIComponent(parts[0]) } catch { throw usage('Invalid URL encoding') }
  }
  return value.replace(/^spec:/, '')
}
async function boardId (value, config) {
  const id = refIdentifier(value, config, 'bot')
  if (!id.includes('#') && !/^[0-9]+$/.test(id)) return id
  const m = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(id)
  if (!m) throw usage('PR references require an explicit owner/repo#N; SPEC numbers are not PR numbers')
  const origin = originFor(config, 'bot')
  let cursor = null; let pages = 0
  do {
    if (++pages > 100) throw new OperationError('RESOLUTION_LIMIT', 'Reference lookup exceeded 100 pages; use an exact note ID')
    const query = new URLSearchParams({ ns: m[1], limit: '500', ...(cursor ? { cursor } : {}) })
    const { data } = await request(origin, `/api/specs?${query}`)
    if (!Array.isArray(data.specs)) throw new OperationError('INVALID_RESPONSE', 'Spec list has no specs array')
    const matches = data.specs.filter(s => (s.namespace || s.ns) === m[1] && Number(s.number ?? s.n ?? s.pr?.number ?? s.pr) === Number(m[2]))
    if (matches.length > 1) throw new OperationError('AMBIGUOUS_REFERENCE', 'Multiple specs match this reference; use an exact note ID')
    if (matches.length) return matches[0].id
    if (data.next && data.next === cursor) throw new OperationError('INVALID_RESPONSE', 'Spec cursor did not advance')
    cursor = data.next
  } while (cursor)
  throw new OperationError('NOT_FOUND', 'No spec matches this PR reference')
}
function stateFile (file) {
  if (!file) throw usage('--state is required')
  let state
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw usage(`Cannot read checkout state: ${e.message}`) }
  if (state.version !== 1 || state.representation !== 'raw' || typeof state.source !== 'string' || state.digest !== digest(state.source) || !/^"[a-f0-9]{64}"$/.test(state.etag) || typeof state.id !== 'string') throw usage('Invalid or incomplete checkout state')
  return state
}
function envelope (data, extras = {}) { return { schemaVersion: 1, data, ...extras } }
async function reviewPayload (name, options, context) {
  const text = await input(options.bodyFile, context)
  let payload
  if (name === 'review.reply') {
    if (!options.thread || !text.trim() || text.length > 500) throw usage('Reply requires --thread and a nonempty body of at most 500 characters')
    payload = { thread: options.thread, text }
  } else {
    let list
    try { list = JSON.parse(text) } catch { throw usage('Review input must be a JSON array') }
    if (!Array.isArray(list) || !list.length || list.length > 10) throw usage('Review input must contain 1–10 items')
    const suggestion = name === 'review.suggest'
    for (const item of list) {
    const keys = suggestion ? ['quote', 'replacement', 'rationale'] : ['quote', 'text']
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => !keys.includes(k))) throw usage('Review item has unknown fields')
    const say = suggestion ? item.rationale : item.text
    if (typeof say !== 'string' || !say.trim() || say.length > 500 || (item.quote !== undefined && typeof item.quote !== 'string')) throw usage('Review text must contain 1–500 characters and quote must be text')
    if (suggestion && (typeof item.quote !== 'string' || !item.quote.trim() || typeof item.replacement !== 'string' || item.replacement.length > 2000)) throw usage('Suggestion requires a quote and replacement of at most 2000 characters')
    }
    payload = { [suggestion ? 'suggestions' : 'comments']: list }
  }
  return payload
}
async function execute (name, options, args, context) {
  const config = context.config
  if (name.startsWith('auth.')) return envelope(await require('./auth').runAuth(name.split('.')[1], options, context))
  if (name.startsWith('context.')) {
    let Context
    try { ({ Context } = require('./context/runtime')) } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND' || /native binding|bindings file/i.test(e.message)) throw new OperationError('CONTEXT_UNAVAILABLE', 'Install optional tree-sitter dependencies to use local context commands')
      throw e
    }
    if (options.maxTokens < (name === 'context.query' ? 500 : name === 'context.brief' ? 200 : 50)) throw usage('Token budget is too small for this context operation')
    const repo = path.resolve(options.repo || config.env.SPECDOC_REPO || process.cwd())
    const namespaces = (options.namespace || config.env.SPECDOC_NAMESPACE || '').split(',').map(s => s.trim()).filter(Boolean)
    const ctx = await new Context(repo, originFor(config, 'bot'), namespaces).refresh()
    const action = name === 'context.query' ? 'context' : name.split('.')[1]
    const payload = { max_tokens: options.maxTokens, max_docs: options.maxDocs, anchors: options.anchors || [], seen: options.seen || [], query: args[0], id: args[0], task: args[0], direction: options.direction, kind: options.kind, level: options.level, limit: options.limit }
    if (payload.seen.some(s => !/^[a-f0-9]{64}$/.test(s))) throw usage('--seen must contain SHA-256 receipts')
    const text = await ctx[action](payload)
    if (text === null) throw new OperationError('NOT_FOUND', 'Unknown context reference')
    return envelope({ text: `${ctx.header()}\n\n${text}` })
  }
  if (name === 'note.diff') {
    const state = stateFile(options.state)
    const content = await input(options.bodyFile, context)
    const diff = require('diff').createTwoFilesPatch('original', options.bodyFile, state.source, content)
    return envelope({ changed: content !== state.source, diff })
  }
  if (name === 'operation.get') {
    if (!UUID.test(args[0])) throw usage('Operation key must be a UUID')
    const identity = options.identity
    const result = await request(originFor(config, identity), `${identity === 'author' ? '/api/v1' : '/api/bot'}/operations/${args[0]}`, { token: await credential(config, identity) })
    return envelope(result.data)
  }
  if (name.startsWith('spec.')) {
    const origin = originFor(config, 'bot')
    if (name === 'spec.list') {
      const query = new URLSearchParams({ limit: String(options.limit), ...(options.cursor ? { cursor: options.cursor } : {}), ...(options.namespace ? { ns: options.namespace } : {}), ...(options.status ? { status: options.status } : {}) })
      const { data } = await request(origin, `/api/specs?${query}`)
      if (!Array.isArray(data.specs)) throw new OperationError('INVALID_RESPONSE', 'Spec list has no specs array')
      let rows = data.specs
      if (options.fields) {
        const fields = options.fields.split(',')
        const known = ['id', 'urlId', 'alias', 'title', 'url', 'status', 'area', 'kind', 'namespace', 'tags', 'author', 'changed', 'comments', 'suggestions', 'pr', 'prState', 'specPath', 'superseded', 'abstract', 'dependsOn', 'milestone', 'implementers', 'supersedes']
        if (fields.some(f => !known.includes(f))) throw usage(`Unknown list field; choose ${known.join(',')}`)
        rows = rows.map(row => Object.fromEntries(fields.filter(f => Object.hasOwn(row, f)).map(f => [f, row[f]])))
      }
      return envelope(rows, { page: { nextCursor: data.next || null, complete: !data.next }, at: data.at, stale: !!data.stale })
    }
    const id = await boardId(args[0], config)
    let route = `/api/specs/${encodeURIComponent(id)}`
    if (name === 'spec.revisions') route += '/revisions'
    else if (name === 'spec.get' && options.revision) {
      if (!/^(current|[1-9]\d*)$/.test(options.revision)) throw usage('--revision must be current or a revision timestamp')
      route += `/revisions/${options.revision}`
    } else if (name === 'spec.changes') route += `/changes?${new URLSearchParams({ ...(options.from ? { from: options.from } : {}), ...(options.to ? { to: options.to } : {}) })}`
    const { data } = await request(origin, route)
    return envelope(typeof data === 'string' ? { id, content: data, revision: options.revision } : data)
  }
  if (name.startsWith('note.')) {
    const state = name === 'note.update' && options.state ? stateFile(options.state) : null
    if (name === 'note.update' && state) {
      if (config.editorOrigin && config.editorOrigin !== state.origin) throw usage('Checkout state belongs to a different editor origin')
      if (!config.editorOrigin) throw usage('Configure the checkout editor origin before updating')
      if (options.ifMatch) throw usage('Use either --state or --if-match, not both')
    }
    const origin = originFor(config, 'author')
    const id = name === 'note.create' ? null : state?.id || refIdentifier(args[0], config, 'author')
    if (state && args[0] && refIdentifier(args[0], config, 'author') !== state.id) throw usage('Reference does not match checkout state')
    const route = `/api/v1/notes${id ? '/' + encodeURIComponent(id) : ''}`
    if (name === 'note.get' || name === 'note.checkout') {
      if (name === 'note.checkout') {
        if (!options.output) throw usage('--output is required')
        const statePath = options.state || options.output + '.specdoc.json'
        if (path.resolve(options.output) === path.resolve(statePath)) throw usage('Source and state paths must differ')
        if (fs.existsSync(options.output) || fs.existsSync(statePath)) throw usage('Checkout refuses to overwrite existing files')
      }
      const result = await request(origin, route, { token: await credential(config, 'author') })
      if (typeof result.data?.content !== 'string' || !/^"[a-f0-9]{64}"$/.test(result.etag) || typeof result.data.id !== 'string') throw new OperationError('INVALID_RESPONSE', 'Raw note response is incomplete or lacks a strong ETag')
      if (name === 'note.get') return envelope({ ...result.data, etag: result.etag, origin, representation: 'raw' })
      const statePath = options.state || options.output + '.specdoc.json'
      const saved = { version: 1, representation: 'raw', origin, id: result.data.id, source: result.data.content, digest: digest(result.data.content), etag: result.etag, retrievedAt: new Date().toISOString() }
      let wroteSource = false
      try {
        fs.writeFileSync(options.output, result.data.content, { flag: 'wx', mode: 0o600 }); wroteSource = true
        fs.writeFileSync(statePath, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      } catch (e) { if (wroteSource) fs.unlinkSync(options.output); throw e }
      return envelope({ id: saved.id, origin, output: path.resolve(options.output), state: path.resolve(statePath), etag: saved.etag })
    }
    const content = await input(options.bodyFile, context)
    const guard = state?.etag || options.ifMatch
    if (name === 'note.update' && !/^"[a-f0-9]{64}"$/.test(guard || '')) throw usage('Updating requires --state or an exact quoted strong --if-match ETag')
    if (name === 'note.create' && !content.length) throw usage('A new note must contain content')
    const result = await mutation(config, 'author', route, name === 'note.create' ? 'POST' : 'PUT', { content }, guard ? { 'if-match': guard } : {}, options.operationKey)
    return envelope(result.data)
  }
  if (name.startsWith('review.')) {
    const payload = name === 'review.get' ? null : await reviewPayload(name, options, context)
    const id = await boardId(args[0], config)
    const route = `/api/bot/notes/${encodeURIComponent(id)}`
    if (name === 'review.get') return envelope((await request(originFor(config, 'bot'), route, { token: await credential(config, 'bot') })).data)
    if (!/^[a-f0-9]{64}$/.test(options.expectedHash || '')) throw usage('--expected-hash must be the SHA-256 hash from review get')
    const action = { 'review.comment': 'comments', 'review.suggest': 'suggestions', 'review.reply': 'replies' }[name]
    return envelope((await mutation(config, 'bot', `${route}/${action}`, 'POST', { ...payload, expectedHash: options.expectedHash }, {}, options.operationKey)).data)
  }
  throw usage(`Unknown operation: ${name}`)
}
module.exports = { execute, input, envelope, refIdentifier, boardId, stateFile }
