'use strict'
const common = {
  format: { type: 'string', enum: ['json', 'text', 'markdown'], default: 'text' },
  profile: { type: 'string' }, boardUrl: { type: 'string' }, editorUrl: { type: 'string' },
  nonInteractive: { type: 'boolean' }, tokenStdin: { type: 'boolean' }, help: { type: 'boolean' }
}
const text = { type: 'string' }
const bool = { type: 'boolean' }
const integer = (min, max, value) => ({ type: 'integer', min, max, ...(value === undefined ? {} : { default: value }) })
const body = { bodyFile: text }
const mutation = { ...body, operationKey: text }
const context = { repo: text, namespace: text, maxTokens: integer(50, 20000, 1500) }
const operations = {
  'auth.login': { description: 'Authorize this terminal through a browser', flags: { readOnly: bool, expiresInDays: integer(1, 365, 30), storage: { type: 'string', enum: ['keyring', 'file'] }, openBrowser: bool, name: text }, args: [] },
  'auth.status': { description: 'Verify the saved author credential', flags: { offline: bool }, args: [] },
  'auth.logout': { description: 'Revoke and remove the author credential', flags: { localOnly: bool }, args: [] },
  'spec.list': { description: 'List public specs with bounded pagination', flags: { limit: integer(1, 500, 20), cursor: text, namespace: text, status: text, fields: text }, args: [] },
  'spec.get': { description: 'Read a public spec or a raw revision', flags: { revision: text }, args: ['reference'] },
  'spec.revisions': { description: 'List available revisions', flags: {}, args: ['reference'] },
  'spec.changes': { description: 'Compare review snapshots', flags: { from: text, to: text }, args: ['reference'] },
  'note.get': { description: 'Read complete raw author source and its ETag', flags: {}, args: ['reference'] },
  'note.checkout': { description: 'Save complete source and edit state', flags: { output: text, state: text }, args: ['reference'], write: true },
  'note.diff': { description: 'Preview local source changes', flags: { ...body, state: text }, args: [] },
  'note.create': { description: 'Create an author note', flags: mutation, args: [], write: true },
  'note.update': { description: 'Replace complete source using the original ETag', flags: { ...mutation, state: text, ifMatch: text }, args: ['reference?'], write: true },
  'review.get': { description: 'Read raw source and threads as a bot', flags: {}, args: ['reference'] },
  'review.comment': { description: 'Add review comments as a bot', flags: { ...mutation, expectedHash: text }, args: ['reference'], write: true },
  'review.suggest': { description: 'Suggest replacements as a bot', flags: { ...mutation, expectedHash: text }, args: ['reference'], write: true },
  'review.reply': { description: 'Reply to a thread as a bot', flags: { ...mutation, expectedHash: text, thread: text }, args: ['reference'], write: true },
  'operation.get': { description: 'Recover a durable mutation result', flags: { identity: { type: 'string', enum: ['author', 'bot'], default: 'author' } }, args: ['key'] },
  'context.query': { description: 'Select compact task context', flags: { ...context, anchors: { ...text, multiple: true }, seen: { ...text, multiple: true }, maxDocs: integer(1, 32, 24) }, args: ['task'] },
  'context.trace': { description: 'Trace specs to code and back', flags: context, args: ['id'] },
  'context.get': { description: 'Expand a context reference', flags: context, args: ['id'] },
  'context.neighbors': { description: 'Show reference relationships', flags: { ...context, direction: { type: 'string', enum: ['in', 'out', 'both'], default: 'both' } }, args: ['id'] },
  'context.search': { description: 'Find code symbols and specs', flags: { ...context, kind: { type: 'string', enum: ['symbol', 'spec'] }, level: { type: 'string', enum: ['fold', 'preview', 'full'], default: 'fold' }, limit: integer(1, 200, 20) }, args: ['query'] },
  'context.brief': { description: 'Summarize repository and spec context', flags: context, args: [] }
}

const bodies = {
  'note.create': { mediaType: 'text/markdown', description: 'Complete raw Markdown source; preserve frontmatter and CriticMarkup.' },
  'note.update': { mediaType: 'text/markdown', description: 'Complete replacement raw source, guarded by checkout state or If-Match.' },
  'note.diff': { mediaType: 'text/markdown', description: 'Proposed complete raw source to compare against checkout state.' },
  'review.reply': { mediaType: 'text/plain', schema: { type: 'string', minLength: 1, maxLength: 500 } },
  'review.comment': { mediaType: 'application/json', schema: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['text'], properties: { quote: { type: 'string' }, text: { type: 'string', minLength: 1, maxLength: 500 } } } } },
  'review.suggest': { mediaType: 'application/json', schema: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['quote', 'replacement', 'rationale'], properties: { quote: { type: 'string', minLength: 1 }, replacement: { type: 'string', maxLength: 2000 }, rationale: { type: 'string', minLength: 1, maxLength: 500 } } } } }
}
const requiredFlags = {
  'note.checkout': ['output'], 'note.diff': ['state', 'body-file'], 'note.create': ['body-file'], 'note.update': ['body-file'],
  'review.comment': ['expected-hash', 'body-file'], 'review.suggest': ['expected-hash', 'body-file'], 'review.reply': ['expected-hash', 'thread', 'body-file']
}
const kebab = name => name.replace(/[A-Z]/g, c => '-' + c.toLowerCase())
function schema (name) {
  const operation = operations[name]
  if (!operation) throw require('./errors').usage(`Unknown operation: ${name}`)
  return { schemaVersion: 1, operation: name, description: operation.description, sideEffects: !!operation.write || name.startsWith('auth.') && name !== 'auth.status', arguments: operation.args, requiredFlags: requiredFlags[name] || [], ...(bodies[name] ? { bodyFile: bodies[name] } : {}), ...(name === 'note.update' ? { precondition: 'Supply --state, or a reference plus an exact quoted strong --if-match ETag. Never replace a stale guard automatically.' } : {}), flags: Object.fromEntries(Object.entries({ ...common, ...operation.flags }).map(([name, value]) => [kebab(name), value])) }
}
function help (name) {
  if (!name) return ['specdoc — SpecDoc operations for people and agents', '', 'Usage: specdoc GROUP COMMAND [arguments] [options]', '       specdoc schema GROUP.COMMAND [--format json]', '', ...Object.entries(operations).map(([id, op]) => `  ${id.replace('.', ' ').padEnd(20)} ${op.description}`), '', 'Use --help after a command for its flags. Commands never abbreviate.'].join('\n')
  const op = schema(name)
  return [`Usage: specdoc ${name.replace('.', ' ')} ${op.arguments.join(' ')}`, '', op.description, '', ...Object.entries(op.flags).map(([flag, spec]) => `  --${flag}${spec.type === 'boolean' ? '' : ' VALUE'}${spec.default !== undefined ? ` (default: ${spec.default})` : ''}`)].join('\n')
}
module.exports = { operations, common, schema, help, kebab }
