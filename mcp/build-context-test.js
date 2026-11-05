const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js')
const { createServer } = require('./server')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-build-transport-'))
const repo = path.join(directory, 'repo')
fs.mkdirSync(repo)
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
async function main () {
  git('init', '-q')
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'checks', scripts: { test: 'node checks.js', unsafe: 'touch SHOULD_NOT_EXIST' } }))
  git('add', '.')
  git('commit', '-qm', 'Declare tooling fixture')
  const client = new Client({ name: 'build-context-test', version: '0' })
  // Build discovery must bypass the board and symbol-index refresh entirely.
  const server = createServer({ index: { repo }, refresh: async () => { throw new Error('Build should not refresh board context') } })
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const tools = await client.listTools()
    assert.ok(tools.tools.some(t => t.name === 'build'))
    const call = args => client.callTool({ name: 'build', arguments: { max_tokens: 3000, ...args } })
    const result = await call({})
    assert.equal(result.isError, false)
    assert.equal(result.structuredContent.kind, 'specdoc-build-packet')
    assert.equal(result.structuredContent.text, undefined)
    assert.ok(Math.ceil(JSON.stringify(result.structuredContent).length / 4) <= 3000)
    assert.match(result.content[0].text, /Declarations only/)
    assert.equal(fs.existsSync(path.join(repo, 'SHOULD_NOT_EXIST')), false)
    const binary = path.resolve(path.dirname(require.resolve('specdoc-cli')), '../bin/specdoc.js')
    const json = execFileSync(process.execPath, [binary, 'context', 'build', '--repo', repo, '--max-tokens', '3000', '--format', 'json'], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, SPECDOC_BOARD_URL: 'http://127.0.0.1:1', SPECDOC_CONFIG_DIR: path.join(directory, 'no-profile') }
    })
    const { text, ...packet } = JSON.parse(json).data
    assert.equal(text, result.content[0].text)
    assert.deepEqual(packet, result.structuredContent)
    const id = packet.nodes.find(n => n.kind === 'npm-script').id
    const focused = await call({ id })
    assert.equal(focused.isError, false)
    assert.equal(focused.structuredContent.selection.id, id)
    const unknown = await call({ id: 'build:missing' })
    assert.equal(unknown.isError, true)
    assert.match(unknown.content[0].text, /NOT_FOUND/)
    const tiny = await call({ max_tokens: 500 })
    assert.equal(tiny.isError, true)
    assert.match(tiny.content[0].text, /BUDGET_TOO_SMALL/)
  } finally {
    await client.close()
    await server.close()
  }
}
main().then(() => console.log('bounded build context CLI/MCP transport ok'), error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => fs.rmSync(directory, { recursive: true, force: true }))
