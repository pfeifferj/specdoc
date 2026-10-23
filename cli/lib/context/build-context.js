'use strict'
const { Build } = require('./build')
const { OperationError, usage } = require('../errors')

function renderBuild (packet) {
  const { counts, omissions } = packet
  return [
    `build declarations: ${packet.repository}; revision ${packet.revision || 'unknown'}${packet.dirty ? '+dirty' : ''}`,
    `${counts.delivered.nodes}/${counts.selected.nodes} nodes, ${counts.delivered.edges}/${counts.selected.edges} relationships, ${counts.delivered.gaps}/${counts.selected.gaps} source gaps; ${packet.complete ? 'selection delivered' : 'partial or unresolved'}`,
    'Declarations only: no command executed, runtime availability or requirement satisfaction established.',
    ...packet.nodes.map(node => `${node.id}  ${node.kind}${node.name ? `  ${node.name}` : ''}`),
    ...packet.edges.map(edge => `${edge.from} --${edge.relation}--> ${edge.to}`),
    omissions.nodes || omissions.edges || omissions.gaps ? `omitted: ${omissions.nodes} nodes, ${omissions.edges} relationships, ${omissions.gaps} gaps; narrow to a returned node id or raise max_tokens` : ''
  ].filter(Boolean).join('\n')
}

function boundedBuildPacket (graph, { id = null, max_tokens = 1500 } = {}) {
  if (!Number.isSafeInteger(max_tokens) || max_tokens < 500 || max_tokens > 20000) throw usage('Build context budget must be an integer from 500 to 20000 tokens')
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  if (id && !byId.has(id)) throw new OperationError('NOT_FOUND', 'Unknown build context id; use an exact node id returned by context build')
  const edges = id ? graph.edges.filter(edge => edge.from === id || edge.to === id) : graph.edges
  const selectedIds = id ? new Set([id, ...edges.flatMap(edge => [edge.from, edge.to])]) : new Set(byId.keys())
  const nodes = graph.nodes.filter(node => selectedIds.has(node.id))
  const evidencePaths = new Set([...nodes, ...edges].flatMap(fact => (fact.evidence || []).map(e => e.path)))
  const gaps = id ? graph.gaps.filter(gap => gap.path === null || evidencePaths.has(gap.path)) : graph.gaps
  const packet = { schemaVersion: 1, kind: 'specdoc-build-packet', repository: graph.repository, revision: graph.revision,
    dirty: graph.dirty, trackedOnly: true, declarationOnly: true, selection: { id },
    nodes: [], edges: [], gaps: [], limits: [...graph.limits],
    counts: { graph: { nodes: graph.nodes.length, edges: graph.edges.length, gaps: graph.gaps.length },
      selected: { nodes: nodes.length, edges: edges.length, gaps: gaps.length }, delivered: { nodes: 0, edges: 0, gaps: 0 } },
    omissions: { nodes: nodes.length, edges: edges.length, gaps: gaps.length }, complete: false, text: '' }
  const update = () => {
    packet.counts.delivered = { nodes: packet.nodes.length, edges: packet.edges.length, gaps: packet.gaps.length }
    packet.omissions = { nodes: nodes.length - packet.nodes.length, edges: edges.length - packet.edges.length, gaps: gaps.length - packet.gaps.length }
    packet.complete = !packet.omissions.nodes && !packet.omissions.edges && !packet.omissions.gaps && !gaps.length
    packet.text = renderBuild(packet)
  }
  // The structured CLI envelope is counted too; text output and MCP use this
  // same limited selection rather than serializing the unrestricted graph.
  const size = () => Math.ceil(JSON.stringify({ schemaVersion: 1, data: packet }).length / 4)
  update()
  if (size() > max_tokens) throw new OperationError('BUDGET_TOO_SMALL', 'Build provenance and limits do not fit the response budget', { minimumTokens: size(), maxTokens: max_tokens })
  const accept = (newNodes, edge = null, gap = null) => {
    packet.nodes.push(...newNodes)
    if (edge) packet.edges.push(edge)
    if (gap) packet.gaps.push(gap)
    update()
    if (size() <= max_tokens) return true
    packet.nodes.splice(packet.nodes.length - newNodes.length, newNodes.length)
    if (edge) packet.edges.pop()
    if (gap) packet.gaps.pop()
    update()
    return false
  }
  const included = new Set()
  if (id) {
    if (!accept([byId.get(id)])) throw new OperationError('BUDGET_TOO_SMALL', 'The complete requested build node and its evidence do not fit; raise max_tokens', { maxTokens: max_tokens })
    included.add(id)
  }
  if (gaps.length) accept([], null, gaps[0])
  for (const edge of edges) {
    const missing = [...new Set([edge.from, edge.to])].filter(key => !included.has(key)).map(key => byId.get(key))
    if (missing.some(node => !node)) continue
    if (accept(missing, edge)) for (const node of missing) included.add(node.id)
  }
  for (const node of nodes) {
    if (!included.has(node.id) && accept([node])) included.add(node.id)
  }
  for (const gap of gaps.slice(1)) accept([], null, gap)
  return packet
}

function queryBuild (repo, args = {}) {
  const build = new Build(repo).refresh()
  if (args.id && !build.neighbors(args.id)) throw new OperationError('NOT_FOUND', 'Unknown build context id; use an exact node id returned by context build')
  return boundedBuildPacket(build.packet(), args)
}

module.exports = { boundedBuildPacket, queryBuild, renderBuild }
