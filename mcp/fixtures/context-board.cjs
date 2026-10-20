const ORIGIN = 'https://context-fixture.invalid'
const INTRODUCTION = '# Link lifecycle\n\nShared condition: while applying desired state.\n\n'
const ADDRESS_SECTION = '## Tentative addresses\n\nReject an invalid address unless it is explicitly marked tentative.\n\n'
const RETRY_SECTION = '# Retry timing\n\nRetry validation after a tentative address becomes ready.\n'
const document = (id, pr, title, body) => ({
  id,
  alias: null,
  namespace: 'netfyr/specs',
  title,
  abstract: 'Implementation behavior.',
  status: 'approved',
  kind: 'feature',
  area: 'core',
  tags: [],
  author: 'fixture',
  changed: '2026-10-01T00:00:00Z',
  comments: 0,
  suggestions: 0,
  pr,
  prState: 'merged',
  specPath: `specs/${id}.md`,
  superseded: false,
  dependsOn: [],
  supersedes: null,
  url: `${ORIGIN}/${id}`,
  body
})
const documents = [
  document('lifecycle', 7, 'Link lifecycle', INTRODUCTION + ADDRESS_SECTION +
    '## Audit log\n\n' + 'Journal-only details belong in diagnostic output. '.repeat(300) + '\n'),
  document('timing', 8, 'Retry timing', RETRY_SECTION)
]

function install () {
  const originalFetch = global.fetch
  global.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.origin !== ORIGIN) return originalFetch(input, options)
    const method = options?.method || (input instanceof Request ? input.method : 'GET')
    if (method !== 'GET') return new Response('fixture only serves GET', { status: 405 })
    const headers = { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' }
    if (url.pathname === '/api/specs') {
      return new Response(JSON.stringify({
        at: '2026-10-01T00:00:00Z', stale: false, next: null,
        specs: documents.map(({ body, ...metadata }) => metadata)
      }), { headers })
    }
    const match = /^\/api\/specs\/([^/]+)$/.exec(url.pathname)
    const doc = match && documents.find(d => d.id === decodeURIComponent(match[1]))
    return doc
      ? new Response(JSON.stringify(doc), { headers })
      : new Response('{}', { status: 404, headers })
  }
  return () => { global.fetch = originalFetch }
}

if (process.env.SPECDOC_CONTEXT_FIXTURE === '1') install()

module.exports = { ORIGIN, INTRODUCTION, ADDRESS_SECTION, RETRY_SECTION, documents, install }
