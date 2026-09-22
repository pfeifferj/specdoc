const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const Module = require('module')
const crypto = require('crypto')
const { EventEmitter } = require('events')
process.env.NAMESPACES = 'a/specs,old/specs'
const file = path.join(__dirname, 'server.js')
const title = 'Withdrawn title sentinel'
const publicText = 'Withdrawn body sentinel.'
const privateText = 'Fresh private snapshot sentinel.'
const revisionText = 'Raw revision sentinel.'
const hash = text => crypto.createHash('sha256').update(text).digest('hex')
const queries = []
const external = []
let permission = 'editable'
let databaseFailure = false
const visible = () => permission !== 'deleted' && (permission == null || ['freely', 'editable', 'locked'].includes(permission))
const rows = [
  { id: 1, note_id: 'fixture', kind: 'status', label: 'draft', hash: hash(publicText), taken_at: new Date() },
  { id: 2, note_id: 'fixture', kind: 'status', label: 'in-review', hash: hash(privateText), taken_at: new Date() }
]
const milestone = { id: '1', namespace: 'a/specs', title: 'Public milestone', description: '', state: 'open', version: 1 }
const assignments = ['fixture', 'companion'].map(noteId => ({ noteId, namespace: 'a/specs', milestoneId: '1', version: 1,
  implementers: noteId === 'fixture' ? [{ id: 'secret-user', login: 'WithdrawnImplementer', name: 'Withdrawn implementer' }] : [] }))
class FakePool extends EventEmitter {
  async query (sql, args) {
    queries.push(sql)
    if (databaseFailure) throw Object.assign(new Error('fixture database unavailable'), { code: 'ECONNREFUSED' })
    if (sql.includes('SELECT shortid FROM "Notes"')) {
      assert.ok(sql.includes('permission'), 'bulk visibility must query current permissions')
      return { rows: args[0].filter(id => id === 'companion' || (id === 'fixture' && visible())).map(shortid => ({ shortid })) }
    }
    if (sql.includes('SELECT 1 FROM "Notes"')) return { rows: visible() ? [{ exists: true }] : [] }
    if (sql.includes('SELECT id, note_id, kind')) return { rows }
    if (sql.includes('SELECT b.body')) return { rows: [{ body: args[0] === 2 ? privateText : publicText }] }
    throw new Error('Unexpected database request: ' + sql)
  }
}
const mod = new Module(file + '.privacy-test', module)
mod.filename = file
mod.paths = Module._nodeModulePaths(__dirname)
const realRequire = mod.require.bind(mod)
mod.require = id => {
  if (id === 'pg') return { Pool: FakePool }
  if (id === './roadmap-store') return { createRoadmapStore: () => ({ read: async ({ namespaces = null, noteIds = null } = {}) => ({
    milestones: !namespaces || namespaces.includes(milestone.namespace) ? [milestone] : [],
    assignments: assignments.filter(a => (!namespaces || namespaces.includes(a.namespace)) && (!noteIds || noteIds.includes(a.noteId)))
  }) }) }
  return realRequire(id)
}
mod._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.fixture = { server, cache: (specs, state) => { snapshot = { specs, state, graph: specGraph(specs, state), at: Date.now() }; lastPollOk = Date.now() } };', file)
const fixture = mod.exports.fixture
const note = (shortid, name, body, extra = '') => ({ shortid, id: shortid, title: name, permission: 'editable',
  lastchangeAt: new Date().toISOString(), content: `---\ntags: [spec, approved]\nnamespace: a/specs\n${extra}---\n# ${name}\n\n${body}\n` })
const cachedSpecs = mod.exports.specsFromRows([
  { ...note('fixture', title, publicText), alias: 'withdrawn-alias' },
  note('companion', 'Companion visible spec', 'Unrelated public text.', 'depends-on: [fixture]\n')
]).map(spec => mod.exports.applyRoles(spec, null))
const state = new Map([
  ['fixture', { namespace: 'a/specs', pr_number: 1, pr_state: 'merged', implemented_at: new Date().toISOString() }],
  ['companion', { namespace: 'a/specs', pr_number: 2, pr_state: 'merged' }]
])
fixture.cache(cachedSpecs, state)
const originalFetch = global.fetch
global.fetch = async url => {
  external.push(url)
  if (!visible()) return { ok: false, status: 404 }
  return { ok: true, json: async () => url.endsWith('/revision')
    ? { revision: [{ time: 1000, length: revisionText.length }] } : { content: revisionText } }
}
let requestNumber = 0
async function request (url, headers = {}) {
  queries.length = 0
  external.length = 0
  const req = { method: 'GET', url, headers, socket: { remoteAddress: 'privacy-test-' + (++requestNumber) } }
  const res = {
    writeHead (code, headers = {}) { this.code = code; this.headers = headers; return this },
    end (body) { this.body = String(body); return this }
  }
  await fixture.server.listeners('request')[0](req, res)
  return res
}
const collections = ['/', '/index.html', '/?q=Withdrawn', '/map', '/map?format=mermaid', '/api/specs', '/roadmap', '/api/roadmap', '/api/milestones', '/api/milestones/1']
const notes = ['/api/note/fixture', '/api/note/withdrawn-alias', '/api/specs/fixture', '/api/specs/withdrawn-alias',
  '/api/specs/fixture/revisions', '/api/specs/fixture/revisions/current', '/api/specs/fixture/revisions/1000',
  '/changes/fixture?from=1&to=2', '/api/specs/fixture/changes?from=1&to=2']
async function main () {
  try {
    for (const next of ['editable', 'private', 'locked', 'limited', 'protected', null, 'deleted', 'unexpected', 'freely']) {
      permission = next
      for (const url of [...collections, ...notes]) {
        const res = await request(url)
        assert.equal(res.code, notes.includes(url) && !visible() ? 404 : 200, `${next} ${url}`)
        assert.ok(queries[0].includes('permission'), `visibility precedes reading ${url}`)
        if (!visible()) {
          for (const secret of [title, publicText, privateText, revisionText, 'WithdrawnImplementer']) assert.ok(!res.body.includes(secret), `${next} ${url} leaked ${secret}`)
          assert.equal(external.length, 0, 'a withdrawn note never reaches the editor revision fetch')
          if (notes.includes(url)) assert.equal(queries.length, 1, 'a denied note does not read snapshot bodies')
        }
        if (url === '/api/specs') {
          const listed = JSON.parse(res.body).specs
          assert.equal(listed.some(s => s.id === 'fixture'), visible())
          assert.equal(res.headers['Cache-Control'], 'no-store')
        }
        if (url === '/api/roadmap') {
          const result = JSON.parse(res.body)
          assert.equal(result.nodes.some(n => n.id === 'fixture'), visible())
          assert.equal(result.milestones[0].incomplete, !visible())
          assert.equal(result.milestones[0].percent, visible() ? 50 : null)
        }
        if (url === '/map' && visible()) assert.ok(res.body.includes(title), 'the map was actually populated before revocation')
        if (url.includes('/changes') || url.startsWith('/changes/')) {
          assert.equal(res.body.includes('Fresh'), visible(), 'cached diffs also recheck visibility')
        }
      }
      const markdown = await request('/api/specs/fixture', { accept: 'text/markdown' })
      assert.equal(markdown.code, visible() ? 200 : 404)
      assert.equal(markdown.body.includes(publicText), visible())
    }
    permission = 'editable'
    databaseFailure = true
    const originalError = console.error
    console.error = () => {}
    try {
      for (const url of [...collections, ...notes]) {
        const res = await request(url)
        assert.equal(res.code, 500, url)
        assert.equal(res.body, 'server error')
        assert.equal(queries.length, 1)
        assert.equal(external.length, 0)
      }
    } finally { console.error = originalError; databaseFailure = false }
    const pinned = mod.exports.specsFromRows([note('pinned', 'Pinned', 'Body.', 'depends-on: ["#9"]\n')],
      new Map([['pinned', { namespace: 'old/specs', pr_number: 3 }]]))[0]
    assert.equal(pinned.namespace, 'old/specs')
    assert.deepEqual(pinned.dependsOn, [{ ns: 'old/specs', n: 9 }], 'bare references use the pinned namespace before roles are resolved')
    // Whatever the served scripts keep in the browser must be named on the
    // privacy page, and nothing else.
    const wording = { localStorage: 'local storage', sessionStorage: 'session storage' }
    const privacy = (await request('/privacy')).body
    const written = new Map()
    for (const script of ['/board.js', '/shell.js']) {
      const source = (await request(script)).body
      for (const match of source.matchAll(/\b([A-Za-z]+Storage)\.setItem/g)) {
        if (!written.has(match[1])) written.set(match[1], new Set())
        written.get(match[1]).add(script)
      }
    }
    for (const api of written.keys()) assert.ok(wording[api], `/privacy has no wording for ${api}`)
    for (const [api, phrase] of Object.entries(wording)) {
      assert.equal(written.has(api), privacy.includes(phrase), `${api} and the "${phrase}" sentence on /privacy disagree`)
    }
    // Both things the tab's session storage holds are named, not just the first,
    // and so is each moment a served script writes one of them.
    const session = /<p>[^<]*session storage[^<]*<\/p>/.exec(privacy)
    assert.ok(session, 'the session storage sentence is one paragraph')
    assert.ok(session[0].includes("the text you type into the board's filter box"), session[0])
    assert.ok(session[0].includes('the ids of the specs its activity check reports as changed'), session[0])
    const writers = written.get('sessionStorage') || new Set()
    for (const [script, moment] of Object.entries({ '/board.js': 'pressing Refresh', '/shell.js': 'changing a filter' })) {
      assert.equal(writers.has(script), session[0].includes(moment),
        `${script} and "${moment}" on /privacy disagree`)
    }
    console.log('privacy route tests passed')
  } finally { global.fetch = originalFetch }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
