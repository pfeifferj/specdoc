const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { promisify } = require('util')
const execFile = promisify(require('child_process').execFile)
const { Index, git: rawGit } = require('./index')
const { Trace } = require('./trace')
const { clip } = require('./budget')
const { Context } = require('./server')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-mcp-'))
const repo = path.join(tmp, 'repo')
fs.cpSync(path.join(__dirname, 'fixtures', 'rust'), repo, { recursive: true })
// The host's global hooks (gitlint) must not judge fixture commits.
const git = (...a) => rawGit(repo, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@example.org', ...a)
git('init', '-q')
git('remote', 'add', 'origin', 'git@github.com:netfyr/netfyr.git')

const emptyRepo = path.join(tmp, 'empty')
fs.mkdirSync(emptyRepo)
rawGit(emptyRepo, 'init', '-q')
const bare = new Index(emptyRepo).refresh()
assert.strictEqual(bare.head, 'none')
assert.strictEqual(bare.count(), 0)

git('add', 'src/lib.rs', 'Cargo.toml')
git('commit', '-qm', 'add the lease type')
git('add', 'src/dhcp.rs')
git('commit', '-qm', 'renew leases on refresh', '-m', 'implements netfyr/specs#7\nrelated: implements other/specs#4')
fs.appendFileSync(path.join(repo, 'src', 'lib.rs'), '\npub fn local() {}\n')
git('commit', '-qam', 'add a helper', '-m', 'implements #3\x01 and a body with \x1e\x1f control bytes')

const ix = new Index(repo).refresh()
const ids = [...ix.defs()].map(d => ix.idOf(d))
assert.deepStrictEqual(ids.sort(), [
  'sym:src/dhcp.rs#refresh', 'sym:src/lib.rs#Lease', 'sym:src/lib.rs#Renew', 'sym:src/lib.rs#dhcp',
  'sym:src/lib.rs#expired', 'sym:src/lib.rs#local', 'sym:src/lib.rs#new', 'sym:src/lib.rs#renew@13', 'sym:src/lib.rs#renew@9'
].sort())
const lease = ix.resolve('sym:src/lib.rs#Lease')
assert.strictEqual(lease.kind, 'struct')
assert.strictEqual(ix.resolve('src/lib.rs#renew@13').kind, 'method')
assert.strictEqual(ix.resolve('src/lib.rs#renew'), null, 'an ambiguous name needs its @line')
assert.strictEqual(ix.resolve('sym:src/lib.rs#nope'), null)
const refresh = ix.resolve('sym:src/dhcp.rs#refresh')
assert.deepStrictEqual(ix.refsFrom(refresh).map(d => d.name).sort(), ['Lease', 'expired', 'new', 'renew', 'renew'])
const callers = ix.refsTo(ix.resolve('sym:src/lib.rs#new'))
assert.strictEqual(callers.length, 1)
assert.strictEqual(callers[0].in.name, 'refresh')
assert.strictEqual(callers[0].kind, 'call')
assert.ok(ix.refsTo(lease).some(r => r.kind === 'import' && r.file === 'src/dhcp.rs'))
assert.ok(ix.refsTo(lease).some(r => r.kind === 'implementation'))
assert.ok(!ix.refsTo(lease).some(r => r.line === lease.line && r.file === lease.file))
assert.deepStrictEqual(ix.usersOf(ix.file('src/lib.rs')), ['src/dhcp.rs'])
assert.strictEqual(ix.ranked()[0].d.name, 'Lease')
assert.strictEqual(ix.dirty, false)
assert.match(ix.source(refresh), /^3: pub fn refresh/)
assert.match(ix.source(ix.resolve('sym:src/lib.rs#dhcp')), /^1: pub mod dhcp;$/)

// Working-tree edits show up without a restart, a deleted file leaves, and
// an untracked file never enters.
const dhcp = path.join(repo, 'src', 'dhcp.rs')
fs.writeFileSync(dhcp, `// moved down\n${fs.readFileSync(dhcp, 'utf8')}`)
fs.utimesSync(dhcp, new Date(), new Date(Date.now() + 2000))
ix.refresh()
assert.strictEqual(ix.resolve('sym:src/dhcp.rs#refresh').line, 4)
assert.strictEqual(ix.dirty, true)
git('checkout', '-q', '--', 'src/dhcp.rs')
fs.writeFileSync(path.join(repo, 'src', 'extra.rs'), 'pub fn extra() {}\npub fn dup() {} pub fn dup() {}\n')
ix.refresh()
assert.strictEqual(ix.resolve('sym:src/extra.rs#extra'), null)
git('add', 'src/extra.rs')
ix.refresh()
assert.ok(ix.resolve('sym:src/extra.rs#extra'))
assert.strictEqual(ix.files.get('src/extra.rs').defs.filter(d => d.name === 'dup').length, 2, 'two defs on one line stay two')
assert.ok(ix.resolve('sym:src/extra.rs#dup@2'))
fs.unlinkSync(path.join(repo, 'src', 'extra.rs'))
ix.refresh()
assert.strictEqual(ix.resolve('sym:src/extra.rs#extra'), null, 'a tracked file gone from disk leaves the index')
git('rm', '-qf', 'src/extra.rs')
fs.symlinkSync('/etc/hostname', path.join(repo, 'src', 'link.rs'))
git('add', 'src/link.rs')
ix.refresh()
assert.strictEqual(ix.files.has('src/link.rs'), false, 'symlinks are not indexed')
assert.strictEqual(ix.file('src/link.rs'), null)
assert.strictEqual(ix.file('Cargo.toml').defs.length, 0)
assert.match(ix.file('Cargo.toml').text, /^\[package\]/)
git('rm', '-qf', 'src/link.rs')
ix.refresh()

const tr = new Trace(repo).refresh(ix.head)
assert.strictEqual(tr.commits.length, 2)
assert.deepStrictEqual(tr.namespaces().sort(), ['netfyr/netfyr', 'netfyr/specs', 'other/specs'])
assert.deepStrictEqual(tr.forSpec({ namespace: 'netfyr/specs', pr: 7 }).map(c => c.files), [['src/dhcp.rs']])
assert.deepStrictEqual(tr.forSpec({ namespace: 'other/specs', pr: 4 }).map(c => c.files), [['src/dhcp.rs']])
assert.deepStrictEqual(tr.forSpec({ namespace: 'netfyr/netfyr', pr: 3 }).map(c => c.files), [['src/lib.rs']])
assert.deepStrictEqual(tr.forSpec({ namespace: 'netfyr/specs', pr: null }), [])
assert.strictEqual(tr.forFile('Cargo.toml').length, 0)
assert.strictEqual(new Trace(emptyRepo).refresh('none').commits.length, 0)
const noOrigin = path.join(tmp, 'noorigin')
fs.cpSync(repo, noOrigin, { recursive: true })
rawGit(noOrigin, 'remote', 'remove', 'origin')
assert.deepStrictEqual(new Trace(noOrigin).refresh('x').namespaces().sort(), ['netfyr/specs', 'other/specs'], 'a bare #N without an origin names nothing')

const many = Array.from({ length: 200 }, (_, i) => `item ${i} ${'x'.repeat(40)}`)
const cut = clip(many, 300, 'narrow')
assert.match(cut, /\.\.\. 177 more cut by max_tokens=300; narrow$/)
assert.strictEqual(clip(['a', 'b'], 100), 'a\nb')

const corpus = [
  { id: 'aaa', alias: 'lease-renewal', title: 'Lease renewal', url: 'u', status: 'implemented', area: 'dhcp', kind: 'feature', namespace: 'netfyr/specs', tags: [], author: 'j', changed: 't', comments: 0, suggestions: 0, pr: 7, prState: 'merged', specPath: 'specs/007-lease-renewal.md', superseded: false, abstract: 'Renew a lease\nbefore it expires.', dependsOn: ['netfyr/specs#2'], supersedes: null },
  { id: 'bbb', alias: null, title: 'Lease model', url: 'u', status: 'approved', area: 'dhcp', kind: 'feature', namespace: 'netfyr/specs', tags: [], author: 'j', changed: 't', comments: 0, suggestions: 0, pr: 2, prState: 'merged', specPath: 'specs/002-lease-model.md', superseded: false, abstract: 'What a lease is.', dependsOn: [], supersedes: 'netfyr/specs#1' },
  { id: 'ccc', alias: null, title: 'Old lease model', url: 'u', status: 'approved', area: '', kind: 'feature', namespace: 'netfyr/specs', tags: [], author: 'j', changed: 't', comments: 0, suggestions: 0, pr: 1, prState: 'merged', specPath: null, superseded: true, abstract: '', dependsOn: null, supersedes: null },
  { id: 'ddd', alias: null, title: 'Unrelated\ndraft', url: 'u', status: 'draft', area: '', kind: 'feature', namespace: 'other/specs', tags: [], author: 'j', changed: 't', comments: 0, suggestions: 0, pr: null, prState: null, specPath: null, superseded: false, abstract: '', dependsOn: ['ccc'], supersedes: 'ccc' },
  { id: 'eee', alias: null, title: 'Other first', url: 'u', status: 'in-review', area: '', kind: 'feature', namespace: 'other/specs', tags: [], author: 'j', changed: 't', comments: 0, suggestions: 0, pr: 1, prState: 'open', specPath: null, superseded: false, abstract: '', dependsOn: [], supersedes: null }
]
let pages = 0
let bodies = 0
let mode = 'ok'
const api = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (mode === 'down') { res.statusCode = 500; return res.end('nope') }
  res.setHeader('cache-control', 'public, max-age=60')
  res.setHeader('content-type', 'application/json')
  if (u.pathname === '/api/specs') {
    pages++
    if (mode === 'loop') return res.end(JSON.stringify({ specs: [], next: 'again' }))
    if (mode === 'junk') return res.end(JSON.stringify({ specs: 'no' }))
    const page = u.searchParams.get('cursor') ? corpus.slice(2) : corpus.slice(0, 2)
    return res.end(JSON.stringify({ at: '2026-09-20T08:00:00Z', stale: mode === 'stale', specs: page, next: u.searchParams.get('cursor') ? null : 'c2' }))
  }
  const s = corpus.find(s => s.id === u.pathname.split('/').pop())
  if (!s) { res.statusCode = 404; return res.end('{}') }
  bodies++
  res.end(JSON.stringify({ ...s, body: `# ${s.title}\n\nbody of ${s.id}\n${'x'.repeat(4000)}` }))
})

// A second, small board: one retired spec and its replacement, served under
// /near when both are in the same namespace and /far when the replacement is
// outside the scope a checkout selects.
const retiredCorpus = ns => [
  { id: 's7', alias: null, title: 'Lease renewal', url: 'u7', status: 'approved', area: '', kind: 'feature', namespace: 'o/r', tags: [], author: 'j', changed: 't', comments: 2, suggestions: 1, pr: 7, prState: 'merged', specPath: null, superseded: true, abstract: 'Renew a lease.', dependsOn: [], supersedes: null, milestone: { id: 'm1', title: 'Lease work', state: 'open' }, implementers: [{ id: 1, login: 'bob', name: 'Bob' }] },
  { id: 's9', alias: null, title: 'Lease renewal v2', url: 'u9', status: 'approved', area: '', kind: 'feature', namespace: ns, tags: [], author: 'j', changed: 't', comments: 0, suggestions: 0, pr: 9, prState: 'open', specPath: null, superseded: false, abstract: '', dependsOn: [], supersedes: 'o/r#7' }
]
const retired = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const [, scope, ...rest] = u.pathname.split('/')
  const specs = retiredCorpus(scope === 'far' ? 'o/other' : 'o/r')
  res.setHeader('cache-control', 'public, max-age=60')
  res.setHeader('content-type', 'application/json')
  if (rest[0] === 'api' && rest[1] === 'specs' && rest.length === 2) return res.end(JSON.stringify({ specs, next: null }))
  const s = specs.find(s => s.id === decodeURIComponent(rest[rest.length - 1]))
  if (!s) { res.statusCode = 404; return res.end('{}') }
  res.end(JSON.stringify({ ...s, body: `# ${s.title}\n\nbody of ${s.id}` }))
})

async function main () {
  await new Promise(r => api.listen(0, '127.0.0.1', r))
  await new Promise(r => retired.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${api.address().port}`

  // Namespaces come from the implements-commits; the corpus is fetched once
  // per max-age.
  const ctx = await new Context(repo, url, []).refresh()
  assert.deepStrictEqual(ctx.specs.namespaces.sort(), ['netfyr/netfyr', 'netfyr/specs', 'other/specs'])
  assert.strictEqual(ctx.specs.specs.length, 5)
  assert.strictEqual(pages, 2)
  await ctx.refresh()
  assert.strictEqual(pages, 2)
  assert.match(ctx.header(), /^index [0-9a-f]{7}: 2 files, 9 symbols; specs: 5 \(netfyr\/netfyr,netfyr\/specs,other\/specs\), board read \d+[smhd] ago$/)

  // Explicit scopes never import unrelated specs when their namespace is empty.
  const pinned = await new Context(repo, url, ['other/specs']).refresh()
  assert.strictEqual(pinned.specs.specs.length, 2)
  assert.strictEqual(pinned.specs.scope, 'other/specs')
  const nobody = await new Context(repo, url, ['nobody/nothing']).refresh()
  assert.strictEqual(nobody.specs.specs.length, 0)
  assert.strictEqual(nobody.specs.scope, 'nobody/nothing')
  assert.strictEqual(nobody.specs.resolve('spec:aaa'), null)
  assert.strictEqual(nobody.resolve('spec:aaa').outsideScope, true, 'an explicit reference still reaches the corpus')
  assert.strictEqual(nobody.specs.search('lease').length, 0)
  const inferredEmpty = new Context(repo, url, [])
  inferredEmpty.log.namespaces = () => ['nobody/nothing']
  await inferredEmpty.refresh()
  assert.strictEqual(inferredEmpty.specs.specs.length, 5)
  assert.strictEqual(inferredEmpty.specs.scope, 'all')

  mode = 'stale'
  ctx.specs.expires = 0
  await ctx.refresh()
  assert.strictEqual(ctx.specs.specs.length, 5)
  assert.strictEqual(ctx.specs.at, '2026-09-20T08:00:00.000Z')
  assert.match(ctx.header(), /, board read \d+[smhd] ago, stale: board reported stale data from 2026-09-20T08:00:00\.000Z$/)

  // A board outage serves the last corpus and says so; with no corpus yet it
  // is an error the tool reports, not a crash.
  mode = 'down'
  ctx.specs.expires = 0
  await ctx.refresh()
  assert.strictEqual(ctx.specs.specs.length, 5)
  assert.match(ctx.header(), /stale: \/api\/specs\?limit=500: 500$/)
  const cold = new Context(repo, url, [])
  await assert.rejects(cold.refresh(), /500/)
  // The tool reports that rejection through render(), which prints the header.
  assert.match(cold.header(), /specs: 0 \(all\), never fetched; scope: every project/)
  mode = 'loop'
  await assert.rejects(new Context(repo, url, []).refresh(), /more than 100 pages/)
  mode = 'junk'
  await assert.rejects(new Context(repo, url, []).refresh(), /no specs array/)
  mode = 'ok'
  ctx.specs.expires = 0
  await ctx.refresh()
  assert.strictEqual(ctx.specs.error, null)

  let out = ctx.search({ query: 'lease', level: 'fold', limit: 20, max_tokens: 1500 })
  assert.match(out, /symbols \(1\):\nsym:src\/lib.rs#Lease  struct L3-6/)
  assert.match(out, /specs \(3\):\nspec:netfyr\/specs#7  implemented  Lease renewal/)
  out = ctx.search({ query: 'renew', kind: 'symbol', level: 'preview', limit: 1, max_tokens: 1500 })
  assert.match(out, /symbols \(3\):\nsym:src\/lib.rs#renew@9  method L9-9\n    fn renew\(&mut self, ttl: u32\);$/)
  out = ctx.search({ query: 'dhcp.rs', kind: 'symbol', level: 'full', limit: 5, max_tokens: 1500 })
  assert.match(out, /sym:src\/dhcp.rs#refresh[^]*\n3: pub fn refresh/)
  assert.strictEqual(ctx.search({ query: 'zzz', level: 'fold', limit: 5, max_tokens: 100 }), 'no match; try a shorter name or a path fragment')
  assert.strictEqual(ctx.search({ query: '   ', level: 'fold', limit: 5, max_tokens: 100 }), 'empty query')
  out = ctx.search({ query: 'e', kind: 'symbol', level: 'full', limit: 50, max_tokens: 120 })
  assert.ok(out.split('\nsym:').length < 8, 'the budget cut the list')
  assert.match(out, /more cut by max_tokens=120/)

  assert.strictEqual(ctx.resolve('src/lib.rs#Lease').type, 'sym')
  assert.strictEqual(ctx.resolve('netfyr/specs#7').s.id, 'aaa')
  assert.strictEqual(ctx.resolve('#7').s.id, 'aaa', 'a bare number matches the one namespace holding it')
  assert.strictEqual(ctx.resolve('#1'), null, 'a bare number held by two namespaces names neither')
  assert.strictEqual(ctx.resolve('lease-renewal').s.id, 'aaa')
  assert.strictEqual(ctx.resolve('spec:ddd').s.id, 'ddd')
  assert.strictEqual(ctx.resolve('src/lib.rs').type, 'file')
  assert.strictEqual(ctx.resolve('file:../../../etc/passwd'), null, 'only tracked paths are files')
  assert.strictEqual(ctx.resolve('file:src'), null)
  assert.strictEqual(ctx.resolve('commit:' + tr.commits[0].sha).type, 'commit')
  assert.strictEqual(ctx.resolve('nothing'), null)

  out = ctx.neighbors({ id: 'sym:src/lib.rs#new', direction: 'both', max_tokens: 1500 })
  assert.match(out, /referenced by \(1\):\nsrc\/dhcp.rs:4  call  in sym:src\/dhcp.rs#refresh/)
  assert.match(out, /references \(1\):\nsym:src\/lib.rs#Lease/)
  assert.match(out, /in file:src\/lib.rs\nspecs \(1\):\nspec:netfyr\/netfyr#3  \(not on the board\)/)
  out = ctx.neighbors({ id: 'sym:src/lib.rs#new', direction: 'in', max_tokens: 1500 })
  assert.doesNotMatch(out, /references \(/)
  out = ctx.neighbors({ id: 'spec:netfyr/specs#2', direction: 'both', max_tokens: 1500 })
  assert.match(out, /supersedes: spec:netfyr\/specs#1  approved \(retired\)  Old lease model/)
  assert.match(out, /needed by \(1\):\nspec:netfyr\/specs#7/)
  out = ctx.neighbors({ id: 'spec:netfyr/specs#1', direction: 'both', max_tokens: 1500 })
  assert.match(out, /needed by \(1\):\nspec:ddd  draft  Unrelated draft\nsuperseded by \(2\):\nspec:netfyr\/specs#2  approved  Lease model\nspec:ddd  draft  Unrelated draft/)
  out = ctx.neighbors({ id: 'spec:netfyr/specs#7', direction: 'both', max_tokens: 1500 })
  assert.match(out, /depends on \(1\):\nspec:netfyr\/specs#2  approved  Lease model/)
  assert.match(out, /commits \(1\):\ncommit:[0-9a-f]+  renew leases on refresh\nfiles \(1\):\nfile:src\/dhcp.rs/)
  out = ctx.neighbors({ id: 'file:src/lib.rs', direction: 'both', max_tokens: 1500 })
  assert.match(out, /defines \(8\):/)
  assert.match(out, /used by \(1\):\nfile:src\/dhcp.rs/)
  out = ctx.neighbors({ id: 'file:Cargo.toml', direction: 'both', max_tokens: 1500 })
  assert.strictEqual(out, 'file:Cargo.toml  0 symbols')
  assert.strictEqual(ctx.neighbors({ id: 'sym:x#y', direction: 'both', max_tokens: 10 }), null)

  // get fetches a body per call and cuts it line by line, never whole.
  assert.strictEqual(bodies, 0)
  out = await ctx.get({ id: 'netfyr/specs#7', max_tokens: 1500 })
  assert.strictEqual(bodies, 1)
  assert.match(out, /pr: #7 \(merged\)  path: specs\/007-lease-renewal.md/)
  assert.match(out, /body of aaa/)
  assert.match(out, /commit:[0-9a-f]+  renew leases on refresh\n  file:src\/dhcp.rs  fn refresh/)
  out = await ctx.get({ id: 'netfyr/specs#7', max_tokens: 60 })
  assert.match(out, /^spec:netfyr\/specs#7[^]*\n\.\.\. \d+ more cut by max_tokens=60/)
  out = await ctx.get({ id: 'sym:src/lib.rs#expired', max_tokens: 1500 })
  assert.match(out, /23: {5}pub fn expired\(&self\) -> bool \{/)
  out = await ctx.get({ id: 'sym:src/lib.rs#expired', max_tokens: 20 })
  assert.match(out, /^sym:src\/lib.rs#expired  method L23-25\n[^]*more cut/)
  out = await ctx.get({ id: 'file:src/dhcp.rs', max_tokens: 1500 })
  assert.match(out, /^file:src\/dhcp.rs  11 lines\nsym:src\/dhcp.rs#refresh/)
  out = await ctx.get({ id: 'file:Cargo.toml', max_tokens: 1500 })
  assert.match(out, /^file:Cargo.toml  5 lines\ntrace: no implements-commit touches Cargo.toml$/)

  out = ctx.trace({ id: 'sym:src/dhcp.rs#refresh', max_tokens: 1500 })
  assert.match(out, /^commit:[0-9a-f]+  renew leases on refresh\n  spec:netfyr\/specs#7  implemented  Lease renewal\n  spec:other\/specs#4  \(not on the board\)$/)
  assert.match(ctx.trace({ id: 'spec:netfyr/specs#2', max_tokens: 100 }), /no commit in this checkout says "implements netfyr\/specs#2"/)
  assert.match(ctx.trace({ id: 'spec:ddd', max_tokens: 100 }), /implements other\/specs#\?"/)

  out = ctx.brief({ max_tokens: 1000 })
  assert.match(out, /^specs: 1 implemented, 1 approved, 1 draft, 1 in-review\nspec:netfyr\/specs#7[^]*\n\nsrc\/lib.rs:\n  pub mod dhcp;\n  pub struct Lease \{/)
  assert.doesNotMatch(out, /Old lease model/)
  out = ctx.brief({ max_tokens: 60 })
  assert.match(out, /search\(kind=spec\) lists the rest/)
  out = (await new Context(emptyRepo, url, ['netfyr/specs']).refresh()).brief({ max_tokens: 500 })
  assert.match(out, /no indexed code/)

  // A spec outside the scope is readable when it is named outright, and
  // invisible to everything that walks the graph.
  assert.strictEqual(pinned.specs.resolve('netfyr/specs#7'), null)
  assert.strictEqual(pinned.specs.outside('netfyr/specs#7').id, 'aaa')
  assert.strictEqual(pinned.specs.resolve('ddd').id, 'ddd')
  assert.strictEqual(pinned.specs.outside('ddd'), null, 'a scoped hit is never an outside one')
  assert.strictEqual(pinned.resolve('spec:netfyr/specs#7').outsideScope, true)
  assert.strictEqual(pinned.resolve('netfyr/specs#7').outsideScope, true, 'owner/repo#N is explicit without the prefix')
  assert.strictEqual(pinned.resolve('#4'), null, 'a bare number held by no namespace stays unknown')
  assert.strictEqual(pinned.resolve('#7'), null, 'a bare number is never widened past the scope')
  assert.strictEqual(pinned.resolve('spec:#7'), null, 'the prefix does not make a bare number cross the scope')
  assert.strictEqual(pinned.resolve('spec:7'), null)
  assert.strictEqual(pinned.resolve('spec:aaa').outsideScope, true, 'a note id names one spec wherever it lives')
  out = await pinned.get({ id: 'spec:netfyr/specs#7', max_tokens: 1500 })
  assert.match(out, /^Outside this checkout's scope \(other\/specs\); read from the board\.\nspec:netfyr\/specs#7  implemented  Lease renewal\n    Renew a lease before it expires\.\nnamespace: netfyr\/specs/)
  assert.match(out, /body of aaa/)
  assert.strictEqual(pinned.search({ query: 'lease', kind: 'spec', level: 'fold', limit: 20, max_tokens: 1500 }), 'no match; try a shorter name or a path fragment')
  assert.strictEqual(pinned.refLine('netfyr/specs#7'), 'spec:netfyr/specs#7  implemented  Lease renewal  (outside scope)')
  assert.strictEqual(pinned.refLine('nobody/nothing#9'), 'spec:nobody/nothing#9  (not on the board)')
  out = pinned.neighbors({ id: 'spec:netfyr/specs#7', direction: 'both', max_tokens: 1500 })
  assert.match(out, /^Outside this checkout's scope \(other\/specs\); dependents and replacements are not listed\.\nspec:netfyr\/specs#7  implemented  Lease renewal\n/)
  out = pinned.trace({ id: 'spec:netfyr/specs#7', max_tokens: 1500 })
  assert.match(out, /^Outside this checkout's scope \(other\/specs\); any commit here that names it is still listed\.\ncommit:/)
  out = pinned.neighbors({ id: 'spec:ddd', direction: 'both', max_tokens: 1500 })
  assert.match(out, /depends on \(1\):\nspec:netfyr\/specs#1  approved \(retired\)  Old lease model  \(outside scope\)\nsupersedes: spec:netfyr\/specs#1  approved \(retired\)  Old lease model  \(outside scope\)$/)
  assert.doesNotMatch(out, /needed by/)
  assert.doesNotMatch(out, /Outside this checkout's scope/, 'a spec inside the scope carries no scope line')
  assert.match(pinned.header(), /specs: 2 \(other\/specs\), board read \d+[smhd] ago$/)

  // A retired spec says so in every reply, and names the spec that replaced it.
  const rurl = `http://127.0.0.1:${retired.address().port}`
  const near = await new Context(emptyRepo, `${rurl}/near`, ['o/r']).refresh()
  out = await near.get({ id: 'spec:o/r#7', max_tokens: 1500 })
  assert.match(out, /^This spec is retired.\nspec:o\/r#7  approved \(retired\)  Lease renewal\n    Renew a lease.\n/)
  assert.ok(out.includes('retired: superseded by spec:o/r#9 Lease renewal v2'))
  assert.ok(out.includes('open comments: 2  pending suggestions: 1'))
  assert.ok(out.includes('milestone: Lease work (open)'))
  assert.ok(out.includes('implementers: bob'))
  assert.strictEqual(out.split('\n').filter(l => l.startsWith('namespace: ')).length, 1, 'the facts stay one line')
  out = near.search({ query: 'lease', level: 'fold', limit: 20, max_tokens: 1500 })
  assert.match(out, /^spec:o\/r#7  approved \(retired\)  Lease renewal$/m)
  assert.strictEqual(
    near.neighbors({ id: 'spec:o/r#9', direction: 'both', max_tokens: 1500 }),
    'spec:o/r#9  approved  Lease renewal v2\nsupersedes: spec:o/r#7  approved (retired)  Lease renewal')

  const far = await new Context(emptyRepo, `${rurl}/far`, ['o/r']).refresh()
  out = await far.get({ id: 'spec:o/r#9', max_tokens: 1500 })
  assert.strictEqual(far.specs.specs.length, 1, 'the replacement is outside the selected namespace')
  assert.strictEqual(out, null, 'a spelling held by no namespace is still unknown')
  out = await far.get({ id: 'spec:o/other#9', max_tokens: 1500 })
  assert.match(out, /^Outside this checkout's scope \(o\/r\); read from the board\.\nspec:o\/other#9  approved  Lease renewal v2\n/)
  assert.match(out, /body of s9/)
  out = far.trace({ id: 'spec:o/other#9', max_tokens: 1500 })
  assert.match(out, /^Outside this checkout's scope \(o\/r\); any commit here that names it is still listed\.\ntrace: no commit in this checkout says/, 'an empty trace outside the scope still says where the spec sits')
  out = await far.get({ id: 'spec:o/r#7', max_tokens: 1500 })
  assert.ok(out.includes('retired: replacement not in this scope'))

  // Reading every project is a choice the header has to own up to.
  const wide = await new Context(emptyRepo, `${rurl}/near`, []).refresh()
  assert.match(wide.header(), /specs: 2 \(all\), fetched \d+[smhd] ago; scope: every project on the board, because SPECDOC_NAMESPACE is unset and no implements commits named one$/)
  assert.doesNotMatch(near.header(), /every project on the board/)
  // A corpus the board dated by hand has no `at`, so the header dates the read.
  assert.match(near.header(), /specs: 2 \(o\/r\), fetched \d+[smhd] ago$/)

  // One session over the real transport, through the SDK's own client.
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
  const connect = async env => {
    const c = new Client({ name: 't', version: '0' })
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, 'server.js')], cwd: repo, env: { ...process.env, SPECDOC_URL: url, ...env }, stderr: 'inherit' }))
    return c
  }
  const client = await connect({ SPECDOC_REPO: repo, SPECDOC_MAX_TOKENS: 'abc' })
  try {
    const tools = await client.listTools()
    assert.deepStrictEqual(tools.tools.map(t => t.name).sort(), ['brief', 'get', 'neighbors', 'search', 'trace'])
    const call = (name, args) => client.callTool({ name, arguments: args })
    let r = await call('search', { query: 'Lease', kind: 'symbol' })
    assert.match(r.content[0].text, /^index [0-9a-f]{7}: 2 files, 9 symbols; specs: 5/)
    assert.match(r.content[0].text, /sym:src\/lib.rs#Lease  struct L3-6/)
    r = await call('get', { id: 'sym:nope#x' })
    assert.strictEqual(r.isError, true)
    assert.match(r.content[0].text, /^index [0-9a-f]{7}/)
    r = await call('neighbors', { id: 'src/lib.rs#new', direction: 'in' })
    assert.match(r.content[0].text, /referenced by \(1\)/)
    r = await call('trace', { id: 'netfyr/specs#7' })
    assert.match(r.content[0].text, /file:src\/dhcp.rs  fn refresh/)
    r = await call('brief', {})
    assert.match(r.content[0].text, /src\/lib.rs:\n  pub mod dhcp;/)
    r = await call('search', { query: 'x', max_tokens: 999999 })
    assert.strictEqual(r.isError, true, 'the schema caps max_tokens')
    const narrow = await connect({ SPECDOC_REPO: repo, SPECDOC_NAMESPACE: 'other/specs' })
    r = await narrow.callTool({ name: 'get', arguments: { id: 'spec:netfyr/specs#7' } })
    assert.match(r.content[0].text, /specs: 2 \(other\/specs\), board read \d+[smhd] ago\n\nOutside this checkout's scope \(other\/specs\); read from the board\.\n/)
    assert.strictEqual(r.isError, false)
    await narrow.close()
    mode = 'down'
    const fresh = await connect({})
    r = await fresh.callTool({ name: 'search', arguments: { query: 'Lease' } })
    assert.strictEqual(r.isError, true)
    assert.match(r.content[0].text, /^index [0-9a-f]{7}[^]*\n\nerror: \/api\/specs\?limit=500: 500$/)
    await fresh.close()
    mode = 'ok'
  } finally {
    await client.close()
  }

  const outFile = path.join(tmp, 'ctx', 'brief.md')
  const cli = (...args) => execFile(process.execPath, [path.join(__dirname, 'server.js'), ...args], { cwd: repo, env: { ...process.env, SPECDOC_URL: url }, timeout: 15000 })
  await cli('brief', '--out', outFile)
  assert.match(fs.readFileSync(outFile, 'utf8'), /^index [0-9a-f]{7}: 2 files, 9 symbols[^]*src\/lib.rs:\n/)
  assert.match((await cli('brief')).stdout, /^index [0-9a-f]{7}/)
  await assert.rejects(cli('brief', '--out'), /--out/)
}

main().then(() => console.log('ok'), e => { console.error(e); process.exitCode = 1 }).finally(() => {
  api.close()
  retired.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})
