const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js')
const { createManifest } = require('specdoc-cli/context/manifest')
const { Context, createServer } = require('./server')

process.env.SPECDOC_LAYA_URL = ''
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-task-transport-'))
const repo = path.join(directory, 'repo')
fs.mkdirSync(repo)
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
async function main () {
  git('init', '-q')
  fs.writeFileSync(path.join(repo, 'rules.md'), '# Rules\n\n- **FR-001**: Preserve the previous configuration when validation fails.\n')
  fs.writeFileSync(path.join(repo, 'lib.rs'), 'pub struct Configuration;\n')
  git('add', '.')
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Add configuration rules')
  const config = { schemaVersion: 1, implementation: { repository: repo, revision: 'HEAD', scope: ['lib.rs'] },
    selection: { requirementsComplete: true, dependenciesComplete: true }, sources: [{ id: 'rules', namespace: 'example/specs',
      repository: repo, revision: 'HEAD', path: 'rules.md', role: 'governing', authority: 'caller-selected-merged',
      requirements: [{ id: 'FR-001', sections: ['FR-001'] }], dependencies: [] }] }
  const file = path.join(directory, 'task.json')
  fs.writeFileSync(file, JSON.stringify(createManifest(config)))
  const client = new Client({ name: 'task-context-test', version: '0' })
  const server = createServer(new Context(repo, 'http://127.0.0.1:1', ['example/specs']), { allowedRoots: [directory] })
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const tools = await client.listTools()
    const schema = tools.tools.find(t => t.name === 'context').inputSchema.properties
    assert.equal(schema.require_complete.type, 'boolean')
    assert.equal(schema.manifest.type, 'string')
    const call = args => client.callTool({ name: 'context', arguments: { task: 'validation', manifest: file, max_tokens: 3000, ...args } })
    const selected = await call({ require_complete: true })
    assert.equal(selected.isError, false)
    assert.equal(selected.structuredContent.complete, true)
    assert.equal(selected.structuredContent.kind, 'specdoc-context-packet')
    assert.equal(selected.structuredContent.text, undefined)
    assert.match(selected.content[0].text, /Preserve the previous configuration/)
    assert.match(selected.structuredContent.sections[0].text, /Preserve the previous configuration/)
    assert.equal(selected.structuredContent.authority.mergedAuthorityVerified, false)
    const section = await client.callTool({ name: 'get', arguments: { id: selected.structuredContent.sections[0].id, manifest: file, max_tokens: 3000 } })
    assert.equal(section.isError, false)
    assert.match(section.content[0].text, /Preserve the previous configuration/)
    const held = await call({ require_complete: true, seen: selected.structuredContent.receipts })
    assert.equal(held.structuredContent.sections.length, 0)
    assert.equal(held.structuredContent.held.length, selected.structuredContent.sections.length)
    const receiver = await call({ require_complete: true })
    assert.deepEqual(receiver.structuredContent.receipts, selected.structuredContent.receipts)
    config.sources[0].dependencies.push('recovery')
    fs.writeFileSync(file, JSON.stringify(createManifest(config)))
    const incomplete = await call({ require_complete: true })
    assert.equal(incomplete.isError, true)
    assert.equal(incomplete.structuredContent.complete, false)
    assert.ok(incomplete.structuredContent.requiredGaps.some(g => g.code === 'MISSING_DEPENDENCY'))
    const exploration = await call({ require_complete: false })
    assert.equal(exploration.isError, false)
    assert.equal(exploration.structuredContent.complete, false)
  } finally {
    await client.close()
    await server.close()
  }
}
main().then(() => console.log('pinned structured context transport ok'), error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => fs.rmSync(directory, { recursive: true, force: true }))
