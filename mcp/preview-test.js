const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js')

process.env.SPECDOC_BOT_TOKEN = ''
const { createServer } = require('./server')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-preview-transport-'))
const repo = path.join(directory, 'repo')
fs.mkdirSync(repo)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
  cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
}).trim()
const copy = value => JSON.parse(JSON.stringify(value))

function snapshot (root) {
  const entries = []
  const walk = relative => {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const child = path.join(relative, name)
      const absolute = path.join(root, child)
      const stat = fs.lstatSync(absolute)
      entries.push([child, stat.mode, stat.isDirectory() ? 'directory' : hash(fs.readFileSync(absolute))])
      if (stat.isDirectory()) walk(child)
    }
  }
  walk('')
  return entries
}

async function main () {
  git('init', '-q')
  fs.writeFileSync(path.join(repo, 'contract.md'), '# Contract\n\n- **FR-001**: Preserve insertion order.\n')
  fs.writeFileSync(path.join(repo, 'consumer.md'), '# Consumer\n\n- **FR-001**: Read a document through the selected decoder.\n')
  git('add', '.')
  git('commit', '-qm', 'Declare preview fixture')
  const revision = git('rev-parse', 'HEAD')
  const base = file => ({ repository: repo, revision, path: file })
  const candidate = path.join(directory, 'contract-candidate.md')
  fs.writeFileSync(candidate, '# Contract\n\n- **FR-001**: Preserve insertion order and duplicate contributions.\n')
  const bundle = {
    schemaVersion: 1,
    title: 'Clarify contribution retention',
    inventory: { reviewed: true, reviewedBy: 'Fixture maintainer' },
    sources: [
      { id: 'contract', base: base('contract.md'), candidate: { file: candidate, sha256: hash(fs.readFileSync(candidate)) } },
      { id: 'consumer', base: base('consumer.md'), candidate: base('consumer.md') }
    ],
    obligations: [{ id: 'amend-order', from: { source: 'contract', selector: { label: 'FR-001' } }, disposition: 'amended', to: [{ source: 'contract', selector: { label: 'FR-001' } }], rationale: 'Keep duplicate contributions explicit' }],
    provides: [], requires: [], relations: [], rules: [], exceptions: []
  }
  const save = (name, value) => {
    const file = path.join(directory, `${name}.json`)
    fs.writeFileSync(file, JSON.stringify(value))
    return file
  }
  const validFile = save('valid', bundle)
  const missing = copy(bundle)
  missing.obligations = []
  const missingFile = save('missing-disposition', missing)
  const misleading = copy(bundle)
  misleading.provides = [{ capability: 'yaml-decoder', source: 'contract', selector: { label: 'FR-001' } }]
  misleading.requires = [{ capability: 'yaml-decoder', consumer: 'consumer', provider: 'contract' }]
  misleading.relations = [{ type: 'implementation', from: 'consumer', to: 'contract' }]
  const misleadingFile = save('wrong-but-connected', misleading)
  const largeCandidate = path.join(directory, 'large-candidate.md')
  fs.writeFileSync(largeCandidate, `# Contract\n\n- **FR-001**: ${'Preserve insertion order and duplicate contributions. '.repeat(128)}\n`)
  const large = copy(bundle)
  large.sources[0].candidate = { file: largeCandidate, sha256: hash(fs.readFileSync(largeCandidate)) }
  const largeFile = save('large', large)
  const beforeStatus = git('status', '--porcelain')
  const before = snapshot(directory)
  let refreshes = 0
  const server = createServer({ index: { repo }, refresh: async () => { refreshes++; throw new Error('Preview must not refresh board or index') } })
  const client = new Client({ name: 'change-preview-test', version: '0' })
  const binary = path.resolve(__dirname, '../cli/bin/specdoc.js')
  const cli = (config, options = {}) => {
    const invocation = spawnSync(process.execPath, [binary, 'context', 'preview', '--config', config, '--max-tokens', String(options.max_tokens || 6000), ...(options.text ? [] : ['--format', 'json']), ...(options.require_valid ? ['--require-valid'] : [])], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, SPECDOC_URL: 'http://127.0.0.1:1', SPECDOC_BOARD_URL: 'http://127.0.0.1:1', SPECDOC_CONFIG_DIR: path.join(directory, 'no-profile') }
    })
    if (invocation.error) throw invocation.error
    return { status: invocation.status, stdout: invocation.stdout, stderr: invocation.stderr,
      ...(options.text ? {} : { value: JSON.parse(invocation.status === 0 ? invocation.stdout : invocation.stderr) }) }
  }
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const tool = (await client.listTools()).tools.find(item => item.name === 'preview')
    assert.ok(tool)
    assert.equal(tool.inputSchema.properties.config.type, 'string')
    assert.equal(tool.inputSchema.properties.require_valid.type, 'boolean')
    assert.equal(tool.inputSchema.properties.max_tokens.maximum, 32000)
    assert.equal(tool.inputSchema.properties.manifest, undefined)
    const call = (config, args = {}) => client.callTool({ name: 'preview', arguments: { config, max_tokens: 6000, ...args } })
    for (const file of [validFile, misleadingFile]) {
      const fromMcp = await call(file, { require_valid: true })
      const fromCli = cli(file, { require_valid: true })
      assert.equal(fromCli.status, 0)
      assert.equal(fromMcp.isError, false)
      const { text, ...packet } = fromCli.value.data
      assert.equal(text, fromMcp.content[0].text)
      assert.deepEqual(packet, fromMcp.structuredContent)
      assert.equal(packet.kind, 'specdoc-change-preview')
      assert.equal(packet.structurallyValid, true)
      assert.equal(packet.semanticPreservationVerified, false)
      assert.equal(packet.authorityVerified, false)
      assert.equal(packet.publicationAttempted, false)
      assert.equal(packet.readOnly, true)
      assert.ok(Math.ceil(JSON.stringify(fromCli.value).length / 4) <= 6000)
    }
    const largerMcp = await call(validFile, { require_valid: true, max_tokens: 32000 })
    const largerCli = cli(validFile, { require_valid: true, max_tokens: 32000 })
    assert.equal(largerMcp.isError, false)
    assert.equal(largerCli.status, 0)
    const { text: largerText, ...largerPacket } = largerCli.value.data
    assert.equal(largerText, largerMcp.content[0].text)
    assert.deepEqual(largerPacket, largerMcp.structuredContent)
    const overwrite = spawnSync(process.execPath, [path.resolve(__dirname, 'server.js'), 'preview', '--config', validFile, '--out', candidate], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, SPECDOC_URL: 'http://127.0.0.1:1' }
    })
    assert.notEqual(overwrite.status, 0)
    assert.match(overwrite.stderr, /EEXIST/)
    const invalidMcp = await call(missingFile, { require_valid: true })
    const invalidCli = cli(missingFile, { require_valid: true })
    assert.notEqual(invalidCli.status, 0)
    assert.equal(invalidCli.value.error.code, 'INVALID_CHANGE')
    assert.equal(invalidMcp.isError, true)
    const { text: missingText, ...missingPacket } = invalidCli.value.error.details.packet
    assert.equal(typeof missingText, 'string')
    assert.deepEqual(missingPacket, invalidMcp.structuredContent)
    assert.equal(missingPacket.structurallyValid, false)
    assert.ok(missingPacket.diagnostics.some(item => item.severity === 'error'))
    const invalidText = cli(missingFile, { require_valid: true, text: true })
    assert.notEqual(invalidText.status, 0)
    assert.match(invalidText.stderr, /UNASSIGNED_OBLIGATION.*contract:FR-001/)
    const exploratory = await call(missingFile)
    assert.equal(exploratory.isError, false)
    assert.equal(exploratory.structuredContent.structurallyValid, false)
    const tinyMcp = await call(largeFile, { max_tokens: 500 })
    const tinyCli = cli(largeFile, { max_tokens: 500 })
    assert.equal(tinyMcp.isError, true)
    assert.match(tinyMcp.content[0].text, /BUDGET_TOO_SMALL/)
    assert.equal(tinyMcp.structuredContent, undefined)
    assert.notEqual(tinyCli.status, 0)
    assert.equal(tinyCli.value.error.code, 'BUDGET_TOO_SMALL')
    assert.equal(tinyCli.value.error.details?.packet, undefined)
    const tinyText = cli(largeFile, { max_tokens: 500, text: true })
    assert.notEqual(tinyText.status, 0)
    assert.match(tinyText.stderr, /Required budget[^\n]*\d+/)
    assert.equal(refreshes, 0)
    assert.equal(git('status', '--porcelain'), beforeStatus)
    assert.deepEqual(snapshot(directory), before)
  } finally {
    await client.close()
    await server.close()
  }
}

main().then(() => console.log('read-only change preview CLI/MCP transport ok'), error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => fs.rmSync(directory, { recursive: true, force: true }))
