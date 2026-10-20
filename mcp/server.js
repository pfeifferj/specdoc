#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const { parseArgs } = require('util')
const { z } = require('zod')
const { Notes } = require('./notes')
const { clip } = require('./budget')

const BOARD = process.env.SPECDOC_URL || 'http://localhost:8080'
// A budget under 50 tokens holds nothing but a trailer.
const tokens = z.coerce.number().int().min(50).max(20000)
const MAX_TOKENS = tokens.catch(1500).parse(process.env.SPECDOC_MAX_TOKENS)
// The brief splits its budget 30/70 between specs and code; under 200 one
// side is nothing but a trailer.
const briefTokens = tokens.min(200)
const BRIEF_TOKENS = briefTokens.catch(1000).parse(process.env.SPECDOC_BRIEF_TOKENS)
const BOT_TOKEN = process.env.SPECDOC_BOT_TOKEN || ''

const ID = 'sym:<path>#<name>, file:<path>, spec:<owner/repo#N>, or commit:<sha>; bare forms are guessed'
const { Context } = require('specdoc-cli/context/runtime')

const render = (ctx, body) => `${ctx.header()}\n\n${body}`
const maxTokens = tokens.default(MAX_TOKENS).describe('response budget; whole items are dropped past it')

// The read tools, served over MCP and from the command line alike.
const TOOLS = {
  search: {
    description: 'Find symbols (by name, then by path fragment) and specs (by words in title or abstract). Returns ids for the other tools. Start here.',
    inputSchema: {
      query: z.string().min(1),
      kind: z.enum(['symbol', 'spec']).optional().describe('restrict to one side'),
      level: z.enum(['fold', 'preview', 'full']).default('fold').describe('fold: one line; preview: plus signature or abstract; full: plus source'),
      limit: z.coerce.number().int().positive().max(200).default(20),
      max_tokens: maxTokens
    }
  },
  neighbors: {
    description: `One hop around an id: callers and callees of a symbol, the symbols of a file and who uses it, the dependencies, dependents and implementing commits of a spec. ${ID}.`,
    inputSchema: {
      id: z.string().min(1),
      direction: z.enum(['in', 'out', 'both']).default('both').describe('in: who uses it; out: what it uses'),
      max_tokens: maxTokens
    }
  },
  get: {
    description: `Everything about one id: a symbol's source, a file's outline, a spec's published body with its implementing commits, or a complete revision-bound section returned by context. ${ID}.`,
    inputSchema: { id: z.string().min(1), max_tokens: maxTokens }
  },
  trace: {
    description: `Spec to code and back: which commits and files implement a spec, or which specs a symbol or file implements. ${ID}.`,
    inputSchema: { id: z.string().min(1), max_tokens: maxTokens }
  },
  brief: {
    description: 'A budgeted map of the repo: spec index and the most referenced symbols with signatures. Call once at the start of a task.',
    inputSchema: { max_tokens: briefTokens.default(BRIEF_TOKENS) }
  },
  context: {
    description: 'Select compact spec context for a development task before it enters your context window. Returns complete sections, source references, receipts and omissions. Selection uses the current board; verify merged requirements for implementation acceptance. Pass seen receipts only for excerpts still present in your own active context; omit them after compaction or delegation. Use get on section ids to expand.',
    inputSchema: {
      task: z.string().trim().min(1).max(8000),
      anchors: z.array(z.string().min(1).max(1024)).max(16).default([]).describe('explicit spec/section targets or file, symbol and commit discovery anchors'),
      seen: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(256).default([]).describe('receipts for complete excerpts still available to this caller'),
      max_docs: z.coerce.number().int().min(1).max(32).default(24).describe('source read limit; protected sources are considered first'),
      max_tokens: tokens.min(500).default(Math.max(500, MAX_TOKENS)).describe('approximate total response budget including provenance and omissions; complete sections only')
    }
  }
}

function createServer (ctx = new Context()) {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
  const server = new McpServer({ name: 'specdoc', version: require('./package.json').version })
  const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError })
  const run = fn => async args => {
    try {
      await ctx.refresh()
      const body = await fn(args)
      if (body === null) return text(render(ctx, `unknown id ${args.id}; ${ID}. search() prints exact ids.`), true)
      return text(render(ctx, body))
    } catch (e) {
      return text(render(ctx, `error: ${e.message}`), true)
    }
  }
  for (const [name, def] of Object.entries(TOOLS)) server.registerTool(name, def, run(a => ctx[name](a)))
  if (BOT_TOKEN) registerWrites(server, ctx, run)
  return server
}

async function serve () {
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
  await createServer().connect(new StdioServerTransport())
}

const NOTE = 'spec id (as search() prints it) or note id'
const HASH = 'expected_hash from read_note; a stale one is refused, read again'

const noteText = n => [
  `note ${n.id} "${n.title}" (${n.namespace}, ${n.status})`,
  `expected_hash: ${n.hash}`,
  n.threads.length ? `open threads:\n${n.threads.map(t => `  ${t.id}  @${t.author}: ${t.text.replace(/\s+/g, ' ')}`).join('\n')}` : 'open threads: none',
  '---'
].join('\n')

const writeText = r => [
  r.written ? 'written' : 'nothing new to write, the note already holds it',
  r.placed !== undefined ? `suggestions placed: ${r.placed}, unanchored (left as comments): ${r.unanchored}` : null,
  `expected_hash: ${r.hash}`
].filter(Boolean).join('\n')

// Only with SPECDOC_BOT_TOKEN: the server is otherwise read-only and holds no
// credential.
function registerWrites (server, ctx, run) {
  const notes = new Notes(BOARD, BOT_TOKEN)
  const write = (action, body) => async a => writeText(await notes.write(ctx.noteId(a.id), action, { expectedHash: a.expected_hash, ...body(a) }))
  const quote = z.string().min(1).describe('exact text from the note body, copied from read_note')
  const say = z.string().min(1).max(500)
  server.registerTool('read_note', {
    description: `The raw note source with CriticMarkup, its open review threads, and the expected_hash every write needs. ${NOTE}.`,
    inputSchema: { id: z.string().min(1).describe(NOTE), max_tokens: tokens.default(8000).describe('whole lines are dropped past it') }
  }, run(async a => {
    const n = await notes.read(ctx.noteId(a.id))
    return `${noteText(n)}\n${clip(n.content.split('\n'), a.max_tokens, 'raise max_tokens to see the rest')}`
  }))
  server.registerTool('comment', {
    description: `Add review comments as this bot. Each lands after the first occurrence of its quote, or at the end without one. Specs in draft or review only. ${HASH}.`,
    inputSchema: {
      id: z.string().min(1).describe(NOTE),
      expected_hash: z.string().regex(/^[a-f0-9]{64}$/).describe(HASH),
      comments: z.array(z.object({ quote: quote.optional(), text: say })).min(1).max(10)
    }
  }, run(write('comments', a => ({ comments: a.comments }))))
  server.registerTool('suggest_edit', {
    description: `Propose replacements for quoted text as suggestions a human accepts or rejects, each with a rationale thread. Reopens review on an approved spec. ${HASH}.`,
    inputSchema: {
      id: z.string().min(1).describe(NOTE),
      expected_hash: z.string().regex(/^[a-f0-9]{64}$/).describe(HASH),
      edits: z.array(z.object({ quote, replacement: z.string().max(2000), rationale: say })).min(1).max(10)
    }
  }, run(write('suggestions', a => ({ suggestions: a.edits }))))
  server.registerTool('reply', {
    description: `Reply in an open review thread by its id from read_note. Specs in draft or review only. ${HASH}.`,
    inputSchema: {
      id: z.string().min(1).describe(NOTE),
      expected_hash: z.string().regex(/^[a-f0-9]{64}$/).describe(HASH),
      thread: z.string().min(1).describe('thread id from read_note, comment-...'),
      text: say
    }
  }, run(write('replies', a => ({ thread: a.thread, text: a.text }))))
}

// `server.js <tool> [query or id] [--option value]`: the same read tools for
// an agent with a shell and no MCP client.
async function cli ([name, ...argv]) {
  const options = { out: { type: 'string' } }
  for (const k of Object.keys(TOOLS[name].inputSchema)) options[k.replace('_', '-')] = {
    type: 'string', ...(name === 'context' && ['anchors', 'seen'].includes(k) ? { multiple: true } : {})
  }
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true })
  const raw = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.replace('-', '_'), v]))
  const first = Object.keys(TOOLS[name].inputSchema)[0]
  if (positionals.length) raw[first] = positionals.join(' ')
  const args = z.object(TOOLS[name].inputSchema).parse(raw)
  const ctx = await new Context().refresh()
  const body = await ctx[name](args)
  if (body === null) throw new Error(`unknown id ${args.id}; ${ID}. search prints exact ids.`)
  const text = `${render(ctx, body)}\n`
  if (values.out) {
    fs.mkdirSync(path.dirname(values.out), { recursive: true })
    fs.writeFileSync(values.out, text)
  } else {
    process.stdout.write(text)
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2)
  const main = Object.hasOwn(TOOLS, argv[0] || '') ? cli(argv) : serve()
  main.catch(e => { console.error(e.message); process.exit(1) })
} else {
  module.exports = { Context, createServer }
}
