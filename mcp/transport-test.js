const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js')
const { ORIGIN, INTRODUCTION, ADDRESS_SECTION, RETRY_SECTION, documents, install } = require('./fixtures/context-board.cjs')
process.env.SPECDOC_BOT_TOKEN = ''
process.env.SPECDOC_LAYA_URL = ''
process.env.SPECDOC_MAX_TOKENS = '1500'
const { Context, createServer } = require('./server')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-context-transport-'))
const repo = path.join(directory, 'repo')
fs.mkdirSync(repo)
const restoreFetch = install()
const serverPath = path.join(__dirname, 'server.js')
const fixturePath = path.join(__dirname, 'fixtures', 'context-board.cjs')
const task = 'tentative address validation'
const env = {
  ...process.env,
  NODE_OPTIONS: `--require=${JSON.stringify(fixturePath)}`,
  SPECDOC_CONTEXT_FIXTURE: '1',
  SPECDOC_URL: ORIGIN,
  SPECDOC_REPO: repo,
  SPECDOC_NAMESPACE: 'netfyr/specs',
  SPECDOC_MAX_TOKENS: '1500',
  SPECDOC_LAYA_URL: '',
  SPECDOC_BOT_TOKEN: ''
}
const git = (...args) => execFileSync('git', [
  '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args
], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
let invocation = 0
const cli = async (...args) => {
  const stdout = path.join(directory, `cli-${++invocation}.out`)
  const stderr = path.join(directory, `cli-${invocation}.err`)
  const output = fs.openSync(stdout, 'w')
  const errors = fs.openSync(stderr, 'w')
  try {
    execFileSync(process.execPath, [serverPath, ...args], {
      cwd: repo, env, timeout: 15000, stdio: ['ignore', output, errors]
    })
    return fs.readFileSync(stdout, 'utf8')
  } catch (error) {
    throw new Error(fs.readFileSync(stderr, 'utf8').trim() || error.message)
  } finally {
    fs.closeSync(output)
    fs.closeSync(errors)
  }
}
const body = text => text.slice(text.indexOf('\n\n') + 2).trimEnd()
const textOf = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
const emitted = text => ({
  ids: [...text.matchAll(/^(section:\S+)/gm)].map(m => m[1]),
  receipts: [...text.matchAll(/^receipt: ([a-f0-9]{64})$/gm)].map(m => m[1])
})

async function main () {
  git('init', '-q')
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(path.join(repo, 'src', 'lib.rs'), 'pub struct Lease {\n    pub retries: u32,\n}\n')
  git('add', 'src/lib.rs')
  git('commit', '-qm', 'Add a fixture symbol')

  const selected = await cli('context', task)
  assert.match(selected, /^index [0-9a-f]{7}: 1 files, 1 symbols;/)
  assert.match(selected, /source: board current published form/)
  assert.ok(selected.includes(ADDRESS_SECTION))
  assert.ok(selected.includes(RETRY_SECTION))
  assert.doesNotMatch(selected, /Journal-only details|## Audit log/)
  assert.ok(Math.ceil(selected.length / 4) <= 1500, 'default context response stays within its budget')
  assert.ok(selected.length < documents.reduce((size, d) => size + d.body.length, 0) / 2, 'transport delivers selected sections instead of the full source')
  const { ids, receipts } = emitted(selected)
  assert.strictEqual(ids.length, 2)
  assert.strictEqual(receipts.length, ids.length)
  const addressId = ids.find(id => id.startsWith('section:lifecycle:'))
  assert.ok(addressId)
  const expandedCli = await cli('get', addressId)
  assert.ok(expandedCli.endsWith(`${INTRODUCTION}\n${ADDRESS_SECTION}\n`), 'section get preserves exact source slices and its ancestor introduction')
  assert.doesNotMatch(expandedCli, /Journal-only details|Retry validation after/)
  assert.strictEqual(body(await cli('context', '--task', task)), body(selected))
  const flags = [...ids.flatMap(id => ['--anchors', id]), ...receipts.flatMap(receipt => ['--seen', receipt])]
  const heldCli = await cli('context', task, ...flags)
  assert.match(heldCli, /0 sections delivered, 2 already held/)
  assert.doesNotMatch(heldCli, /Reject an invalid address|Retry validation after|^receipt:/m)
  assert.match(await cli('search', 'Lease', '--kind', 'symbol'), /sym:src\/lib.rs#Lease  struct L1-3/)
  await assert.rejects(cli('context', '--anchors', addressId), /task/)
  await assert.rejects(cli('context', task, '--seen', 'invalid'), /Invalid/)
  console.log('CLI transport ok (fixture board fetch)')

  const client = new Client({ name: 'specdoc-context-transport-test', version: '0' })
  const server = createServer(new Context(repo, ORIGIN, ['netfyr/specs']))
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const definitions = await client.listTools()
    assert.deepStrictEqual(definitions.tools.map(tool => tool.name).sort(), ['brief', 'context', 'get', 'neighbors', 'search', 'trace'])
    const call = (name, args) => client.callTool({ name, arguments: args })
    for (const invalid of [{}, { task: ' ' }, { task: 'x'.repeat(8001) },
      { task, anchors: 'spec:netfyr/specs#7' }, { task, anchors: Array(17).fill('spec:netfyr/specs#7') },
      { task, seen: ['not-a-receipt'] }, { task, max_tokens: 499 }]) {
      assert.strictEqual((await call('context', invalid)).isError, true, JSON.stringify(invalid).slice(0, 100))
    }
    const first = await call('context', { task })
    assert.strictEqual(first.isError, false)
    assert.strictEqual(body(textOf(first)), body(selected), 'CLI defaults match MCP defaults')
    const expanded = await call('get', { id: addressId })
    assert.strictEqual(expanded.isError, false)
    assert.ok(textOf(expanded).endsWith(`${INTRODUCTION}\n${ADDRESS_SECTION}`), 'section get preserves exact source slices and its ancestor introduction')
    assert.doesNotMatch(textOf(expanded), /Journal-only details|Retry validation after/)

    const repeated = await call('context', { task, seen: receipts })
    assert.strictEqual(repeated.isError, false)
    assert.match(textOf(repeated), /0 sections delivered, 2 already held/)
    assert.doesNotMatch(textOf(repeated), /Reject an invalid address|Retry validation after|^receipt:/m)
    assert.strictEqual(body(textOf(await call('context', { task }))), body(selected), 'a call without receipts still delivers context')
    const search = await call('search', { query: 'Lease', kind: 'symbol' })
    assert.strictEqual(search.isError, false)
    assert.match(textOf(search), /sym:src\/lib.rs#Lease  struct L1-3/)

    assert.strictEqual(body(expandedCli), body(textOf(expanded)))
  } finally {
    await client.close()
    await server.close()
  }
}

main().then(() => console.log('MCP memory transport and CLI ok (mock board)'), error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  restoreFetch()
  fs.rmSync(directory, { recursive: true, force: true })
})
