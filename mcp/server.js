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
  preview: {
    description: 'Preview an explicit local specification change bundle without contacting the board, executing checks or changing approvals/publication. Returns exact source identities, diffs, obligation dispositions and declared structural diagnostics. Resolved transfers never prove semantic preservation or authority.',
    inputSchema: {
      config: z.string().min(1).max(4096).describe('local change-bundle JSON file; its source paths resolve relative to this file'),
      require_valid: z.boolean().default(false).describe('return an error when declared structural checks fail; never a semantic or approval verdict'),
      max_tokens: z.coerce.number().int().min(500).max(32000).default(6000).describe('whole compact JSON packet budget; fails rather than clipping source evidence or diagnostics')
    }
  },
  build: {
    description: 'Inspect bounded build, test and CI declarations with exact source evidence. Reads tracked local files without running commands or contacting the board. Returns whole nodes and relationships, source gaps, counts and omissions; these are declarations, not check results or requirement coverage.',
    inputSchema: {
      id: z.string().min(1).max(8192).optional().describe('exact build node id for one-hop declarations; omit for a bounded overview'),
      repo: z.string().min(1).optional().describe('local checkout; defaults to the configured implementation repository'),
      max_tokens: tokens.min(500).default(Math.max(500, MAX_TOKENS)).describe('approximate compact JSON budget including provenance and the CLI envelope; whole facts omitted beyond it')
    }
  },
  search: {
    description: 'Find symbols (by name, then by path fragment) and specs (by words in title or abstract). Returns ids for targeted navigation. Use context first for task requirements.',
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
    description: 'A budgeted overview of the repo: spec index and the most referenced symbols with signatures. Use when a broad code map is needed alongside task context.',
    inputSchema: { max_tokens: briefTokens.default(BRIEF_TOKENS) }
  },
  context: {
    description: 'Select compact spec context with structured sources, authority, freshness, complete sections, receipts, omissions and required gaps. Board exploration is the default; supply a pinned task manifest for implementation requirements and require_complete to refuse incomplete declared context. Pass seen receipts only for excerpts still present in your active context; omit them after compaction or delegation. Use get with the same manifest to expand sections.',
    inputSchema: {
      task: z.string().trim().min(1).max(8000),
      anchors: z.array(z.string().min(1).max(1024)).max(16).default([]).describe('explicit spec/section targets or file, symbol and commit discovery anchors'),
      seen: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(256).default([]).describe('receipts for complete excerpts still available to this caller'),
      require_complete: z.boolean().default(false).describe('fail unless a pinned manifest and all its declared required context are complete; not a proof that the caller selected all requirements'),
      max_docs: z.coerce.number().int().min(1).max(32).default(24).describe('source read limit; protected sources are considered first'),
      max_tokens: tokens.min(500).default(Math.max(500, MAX_TOKENS)).describe('approximate rendered text budget including provenance and omissions; structured metadata adds overhead; complete source sections only')
    }
  }
}
for (const [name, tool] of Object.entries(TOOLS)) {
  if (!['build', 'preview'].includes(name)) tool.inputSchema.manifest = z.string().min(1).optional().describe('local pinned task manifest path; reads its exact Git revisions without contacting the board')
}

function createServer (ctx = new Context()) {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
  const server = new McpServer({ name: 'specdoc', version: require('./package.json').version })
  const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError })
  const run = (fn, contextTool = false) => async args => {
    let active = ctx
    try {
      if (contextTool && args.manifest) {
        const { loadManifest } = require('specdoc-cli/context/manifest')
        const manifest = loadManifest(args.manifest)
        active = new Context(manifest.implementation.repository, BOARD, [], { manifest: args.manifest })
      }
      await active.refresh()
      const body = await fn(args, active)
      if (body === null) return text(render(active, `unknown id ${args.id}; ${ID}. search() prints exact ids.`), true)
      if (body?.kind === 'specdoc-context-packet') {
        const { text: rendered, ...packet } = body
        return { ...text(render(active, rendered)), structuredContent: packet }
      }
      return text(render(active, body))
    } catch (e) {
      const { text: rendered, ...packet } = e.details?.packet || {}
      return { ...text(render(active, `error: ${e.message}`), true), ...(e.details?.packet ? { structuredContent: packet } : {}) }
    }
  }
  for (const [name, def] of Object.entries(TOOLS)) {
    if (name === 'preview') server.registerTool(name, def, async args => {
      try {
        const { text: rendered, ...packet } = require('specdoc-cli/context/preview').previewFile(args.config, args)
        return { ...text(rendered), structuredContent: packet }
      } catch (e) {
        const { text: rendered, ...packet } = e.details?.packet || {}
        return { ...text(`${e.code || 'OPERATION_FAILED'}: ${e.message}${e.details?.minimumTokens ? `; minimumTokens=${e.details.minimumTokens}` : ''}${rendered ? `\n\n${rendered}` : ''}`, true),
          ...(e.details?.packet ? { structuredContent: packet } : {}) }
      }
    })
    else if (name === 'build') server.registerTool(name, def, async args => {
      try {
        const { queryBuild } = require('specdoc-cli/context/build-context')
        const { text: rendered, ...packet } = queryBuild(args.repo || ctx.index.repo, args)
        return { ...text(rendered), structuredContent: packet }
      } catch (e) { return text(`${e.code || 'OPERATION_FAILED'}: ${e.message}${e.details?.minimumTokens ? `; minimumTokens=${e.details.minimumTokens}` : ''}`, true) }
    })
    else server.registerTool(name, def, run((a, target) => name === 'context' ? target.contextPacket(a) : target[name](a), true))
  }
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
    type: ['require_complete', 'require_valid'].includes(k) ? 'boolean' : 'string', ...(name === 'context' && ['anchors', 'seen'].includes(k) ? { multiple: true } : {})
  }
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true })
  const raw = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.replace('-', '_'), v]))
  const first = Object.keys(TOOLS[name].inputSchema)[0]
  if (positionals.length) raw[first] = positionals.join(' ')
  const args = z.object(TOOLS[name].inputSchema).parse(raw)
  if (name === 'preview') {
    const result = require('specdoc-cli/context/preview').previewFile(args.config, args)
    if (values.out) {
      fs.mkdirSync(path.dirname(values.out), { recursive: true })
      fs.writeFileSync(values.out, result.text + '\n', { flag: 'wx' })
    } else process.stdout.write(result.text + '\n')
    return
  }
  if (name === 'build') {
    const result = require('specdoc-cli/context/build-context').queryBuild(args.repo || process.env.SPECDOC_REPO || process.cwd(), args)
    if (values.out) {
      fs.mkdirSync(path.dirname(values.out), { recursive: true })
      fs.writeFileSync(values.out, result.text + '\n')
    } else process.stdout.write(result.text + '\n')
    return
  }
  const ctx = args.manifest
    ? await new Context(require('specdoc-cli/context/manifest').loadManifest(args.manifest).implementation.repository, BOARD, [], { manifest: args.manifest }).refresh()
    : await new Context().refresh()
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
