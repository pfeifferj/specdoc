'use strict'
const { operations, common, schema, help, kebab } = require('./registry')
const { usage } = require('./errors')
const { resolveConfig } = require('./config')
const { execute, envelope } = require('./operations')
function parse (argv) {
  if (!argv.length || argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) return { help: true }
  if (argv.length === 1 && argv[0] === '--version') return { version: true }
  let name; let rest
  if (argv[0] === 'schema') {
    name = 'schema'; rest = argv.slice(2)
    if (!argv[1] || !operations[argv[1]]) throw usage('schema requires a known GROUP.COMMAND')
  } else {
    name = argv.slice(0, 2).join('.'); rest = argv.slice(2)
    if (!operations[name]) throw usage('Unknown command; run specdoc --help')
  }
  const definitions = { ...common, ...(operations[name]?.flags || {}) }
  const flags = Object.fromEntries(Object.entries(definitions).map(([key, value]) => [kebab(key), { key, ...value }]))
  const options = Object.fromEntries(Object.entries(definitions).filter(([, d]) => d.default !== undefined).map(([k, d]) => [k, d.default]))
  const args = []; const seen = new Set(); let literal = false
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i]
    if (item === '--' && !literal) { literal = true; continue }
    if (!literal && item.startsWith('-')) {
      if (item === '-h') { options.help = true; continue }
      if (!item.startsWith('--')) throw usage(`Unknown flag: ${item}`)
      const at = item.indexOf('=')
      const flag = item.slice(2, at === -1 ? undefined : at)
      const definition = flags[flag]
      if (!definition) throw usage(`Unknown flag: --${flag}`)
      if (seen.has(flag) && !definition.multiple) throw usage(`Duplicate flag: --${flag}`)
      seen.add(flag)
      let value
      if (definition.type === 'boolean') {
        if (at !== -1) throw usage(`--${flag} does not take a value`)
        value = true
      } else {
        value = at === -1 ? rest[++i] : item.slice(at + 1)
        if (value === undefined || value === '' || value.startsWith('--')) throw usage(`--${flag} requires a value`)
        if (definition.type === 'integer') {
          if (!/^\d+$/.test(value)) throw usage(`--${flag} requires an integer`)
          value = Number(value)
          if (!Number.isSafeInteger(value) || value < definition.min || value > definition.max) throw usage(`--${flag} must be between ${definition.min} and ${definition.max}`)
        }
        if (definition.enum && !definition.enum.includes(value)) throw usage(`--${flag} must be ${definition.enum.join(', ')}`)
      }
      if (definition.multiple) (options[definition.key] ||= []).push(value)
      else options[definition.key] = value
    } else args.push(item)
  }
  if (!options.help) {
    const expected = operations[name]?.args || []
    const minimum = expected.filter(a => !a.endsWith('?')).length
    if (args.length < minimum || args.length > expected.length) throw usage(`Expected ${expected.join(' ') || 'no positional arguments'}`)
    if (options.tokenStdin && options.bodyFile === '-') throw usage('stdin cannot supply both a credential and content')
    if (options.seen?.some(value => !/^[a-f0-9]{64}$/.test(value))) throw usage('--seen must contain SHA-256 receipts')
    if (options.anchors?.length > 16 || options.seen?.length > 256) throw usage('Too many context anchors or receipts')
    if (name === 'context.query' && (args[0].length > 8000 || options.maxTokens < 500)) throw usage('Context task must be at most 8000 characters and budget at least 500 tokens')
    if (name === 'context.brief' && options.maxTokens < 200) throw usage('Brief budget must be at least 200 tokens')
    if (options.operationKey && !require('./client').UUID.test(options.operationKey)) throw usage('--operation-key must be a UUID')
    if (name.startsWith('review.') && name !== 'review.get' && !/^[a-f0-9]{64}$/.test(options.expectedHash || '')) throw usage('--expected-hash is required and must be SHA-256')
    if (['note.create', 'note.update', 'note.diff', 'review.comment', 'review.suggest', 'review.reply'].includes(name) && !options.bodyFile) throw usage('--body-file is required')
    if (name === 'note.update' && !options.state && !args[0]) throw usage('Provide a note reference or --state')
    if (name === 'note.update' && !options.state && !/^"[a-f0-9]{64}"$/.test(options.ifMatch || '')) throw usage('An exact quoted strong --if-match ETag or --state is required')
    if (name === 'spec.get' && options.revision && !/^(current|[1-9]\d*)$/.test(options.revision)) throw usage('Invalid revision')
    if (name === 'spec.list' && options.fields) {
      const known = ['id', 'urlId', 'alias', 'title', 'url', 'status', 'area', 'kind', 'namespace', 'tags', 'author', 'changed', 'comments', 'suggestions', 'pr', 'prState', 'specPath', 'superseded', 'abstract', 'dependsOn', 'milestone', 'implementers', 'supersedes']
      if (options.fields.split(',').some(f => !known.includes(f))) throw usage('Unknown list field')
    }
    if (options.format === 'markdown' && !['spec.get', 'note.get', 'note.diff', 'review.get'].includes(name) && !name.startsWith('context.')) throw usage('Markdown output is unavailable for this operation')
  }
  return { name, options, args, schemaName: name === 'schema' ? argv[1] : undefined }
}
const safe = value => String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
function render (result, format) {
  if (format === 'json') return JSON.stringify(result) + '\n'
  const data = result.data
  if (format === 'markdown') {
    const source = typeof data === 'string' ? data : data?.content ?? data?.body ?? data?.diff ?? data?.text
    if (typeof source !== 'string') throw usage('This response has no Markdown representation')
    return source
  }
  if (typeof data === 'string') return safe(data) + '\n'
  if (data?.text) return safe(data.text) + '\n'
  if (data?.diff) return safe(data.diff)
  if (Array.isArray(data)) {
    const rows = data.map(row => typeof row === 'object' ? [row.id, row.title, row.status].filter(Boolean).map(safe).join('\t') || safe(JSON.stringify(row)) : safe(row))
    if (result.page) rows.push(result.page.complete ? 'Complete.' : `Next cursor: ${safe(result.page.nextCursor)}`)
    return rows.join('\n') + '\n'
  }
  return safe(JSON.stringify(data, null, 2)) + '\n'
}
async function main (argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout
  const stderr = io.stderr || process.stderr
  const stdin = io.stdin || process.stdin
  const env = io.env || process.env
  let format = argv.some((arg, i) => arg === '--format=json' || arg === '--format' && argv[i + 1] === 'json') ? 'json' : 'text'
  try {
    const parsed = parse(argv)
    if (parsed.help) { stdout.write(help() + '\n'); return 0 }
    if (parsed.version) { stdout.write(require('../package.json').version + '\n'); return 0 }
    const { name, options, args } = parsed
    format = options.format
    if (options.help) { stdout.write(help(name === 'schema' ? parsed.schemaName : name) + '\n'); return 0 }
    if (name === 'schema') { stdout.write(render(envelope(schema(parsed.schemaName)), format)); return 0 }
    const config = resolveConfig(options, env)
    const context = { config, stdin, stdout, stderr, env }
    if (options.tokenStdin && name !== 'auth.login') {
      let token = ''
      for await (const chunk of stdin) { token += chunk; if (token.length > 4096) throw usage('Credential input is too large') }
      token = token.trim()
      if (!token || /\s/.test(token)) throw usage('stdin must contain one credential')
      config[name.startsWith('review.') || name === 'operation.get' && options.identity === 'bot' ? 'botToken' : 'authorToken'] = token
    }
    stdout.write(render(await execute(name, options, args, context), format))
    return 0
  } catch (e) {
    const error = { code: e.code || 'OPERATION_FAILED', message: e.message, ...(e.status ? { status: e.status } : {}), ...(e.details !== undefined ? { details: e.details } : {}) }
    stderr.write(format === 'json' ? JSON.stringify({ schemaVersion: 1, error }) + '\n' : `${safe(error.code)}: ${safe(error.message)}${error.details?.recovery ? '\n' + safe(error.details.recovery) : ''}\n`)
    return e.exitCode || (e.code === 'INTERRUPTED' ? 130 : 1)
  }
}
module.exports = { main, parse, render, safe }
