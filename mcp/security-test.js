'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js')
const { createManifest } = require('specdoc-cli/context/manifest')
const { createAccessPolicy, withAccess, readRegular } = require('specdoc-cli/context/access')
const { createServer } = require('./server')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-mcp-security-'))
const repo = path.join(directory, 'repo')
const outside = path.join(directory, 'outside')
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
  '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const hash = value => createHash('sha256').update(value).digest('hex')
const write = (file, value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
const stub = () => ({ index: { repo }, refresh: async () => {}, header: () => 'fixture', noteId: id => id })

async function connected (options, work) {
  const server = createServer(stub(), options)
  const client = new Client({ name: 'security-test', version: '0' })
  try {
    const [left, right] = InMemoryTransport.createLinkedPair()
    await server.connect(right)
    await client.connect(left)
    await work(client)
  } finally { await client.close(); await server.close() }
}

async function main () {
  for (const root of [repo, outside]) {
    fs.mkdirSync(root)
    git(root, 'init', '-q')
    write(path.join(root, 'rules.md'), '# Rules\n\n- **FR-001**: Preserve order.\n')
    write(path.join(root, 'package.json'), { name: path.basename(root), scripts: { test: 'node test.js' } })
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'Fixture')
  }
  const revision = git(repo, 'rev-parse', 'HEAD')
  const privateBytes = 'PRIVATE_SOURCE_MUST_NOT_LEAVE_SCOPE'
  const privateFile = path.join(outside, 'candidate.md')
  write(privateFile, privateBytes)
  const bundle = candidate => ({ schemaVersion: 1, sources: [{ id: 'rules', base: { repository: repo, revision, path: 'rules.md' }, candidate }] })
  const nestedFile = path.join(repo, 'nested.json')
  write(nestedFile, bundle({ file: privateFile, sha256: hash(privateBytes) }))
  const externalBundle = path.join(outside, 'external.json')
  write(externalBundle, bundle(null))
  const manifest = createManifest({ schemaVersion: 1,
    implementation: { repository: repo, revision, scope: ['.'] },
    sources: [{ id: 'private', namespace: 'example/specs', repository: outside, revision: 'HEAD', path: 'rules.md',
      role: 'governing', authority: 'caller-selected-merged', requirements: [], dependencies: [] }] })
  const manifestFile = path.join(repo, 'manifest.json')
  write(manifestFile, manifest)
  await connected({}, async client => {
    const rejected = async (name, args, pattern = /outside the configured local roots/) => {
      const result = await client.callTool({ name, arguments: args })
      assert.equal(result.isError, true, `${name} must reject an unauthorized source`)
      assert.match(result.content[0].text, pattern)
      assert.ok(!JSON.stringify(result).includes(privateBytes))
    }
    await rejected('preview', { config: externalBundle })
    await rejected('preview', { config: nestedFile })
    write(nestedFile, bundle({ repository: outside, revision: git(outside, 'rev-parse', 'HEAD'), path: 'rules.md' }))
    await rejected('preview', { config: nestedFile })
    await rejected('context', { task: 'read requirements', manifest: manifestFile })
    await rejected('build', { repo: outside })
    const link = path.join(repo, 'linked.json')
    fs.symlinkSync(externalBundle, link)
    await rejected('preview', { config: link }, /symlink components/)
    fs.unlinkSync(link)
    const linkedRepo = path.join(repo, 'linked-repo')
    fs.mkdirSync(linkedRepo)
    write(path.join(linkedRepo, '.git'), `gitdir: ${path.join(outside, '.git')}\n`)
    await rejected('build', { repo: linkedRepo })
    const common = path.join(repo, '.git', 'commondir')
    write(common, path.join(outside, '.git') + '\n')
    await rejected('build', {})
    fs.unlinkSync(common)
    const alternates = path.join(repo, '.git', 'objects', 'info', 'alternates')
    write(alternates, path.join(outside, '.git', 'objects') + '\n')
    await rejected('build', {}, /object alternates/)
    fs.unlinkSync(alternates)
    const config = path.join(repo, '.git', 'config')
    const original = fs.readFileSync(config)
    fs.appendFileSync(config, `\n[include]\n\tpath = ${path.join(outside, '.git', 'config')}\n`)
    await rejected('build', {}, /configuration includes/)
    fs.writeFileSync(config, original)
    fs.appendFileSync(config, '\n[filter "hostile"]\n\tclean = touch EXECUTED\n')
    await rejected('build', {}, /Git filters/)
    fs.writeFileSync(config, original)
    const valid = await client.callTool({ name: 'build', arguments: { max_tokens: 3000 } })
    assert.equal(valid.isError, false)
  })
  await connected({ allowedRoots: [outside] }, async client => {
    const result = await client.callTool({ name: 'preview', arguments: { config: externalBundle } })
    assert.equal(result.isError, false, 'operator-configured extra root permits explicit access')
  })
  const hasWrites = async options => connected(options, async client => {
    const names = (await client.listTools()).tools.map(tool => tool.name)
    assert.equal(names.includes('comment'), false)
  })
  await hasWrites({ botToken: 'token' })
  await hasWrites({ botToken: 'token', allowWrites: true })
  await connected({ botToken: 'token', allowWrites: true, writeNotes: ['allowed-note'] }, async client => {
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'comment'))
    const result = await client.callTool({ name: 'comment', arguments: { id: 'other-note', expected_hash: 'a'.repeat(64), comments: [{ text: 'no' }] } })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /outside SPECDOC_WRITE_NOTES/)
  })
  const victim = path.join(repo, 'candidate.md')
  write(victim, 'allowed')
  const originalOpen = fs.openSync
  try {
    fs.openSync = function (file, ...args) {
      if (file === victim) { fs.unlinkSync(victim); fs.symlinkSync(privateFile, victim) }
      return originalOpen.call(this, file, ...args)
    }
    assert.throws(() => withAccess(createAccessPolicy([repo]), () => readRegular(victim)), /ELOOP|symlink|changed/)
  } finally { fs.openSync = originalOpen }
  console.log('MCP local roots, nested sources, Git metadata, write grants, and no-follow reads passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => fs.rmSync(directory, { recursive: true, force: true }))
