const http = require('http')
const https = require('https')
const dns = require('dns').promises
const net = require('net')
const ipaddr = require('ipaddr.js')

const MAX_RESPONSE_BYTES = 1024 * 1024
const denied = message => Object.assign(new Error(message), { code: 'MODEL_ENDPOINT_DENIED' })
const hostname = url => url.hostname.replace(/^\[|\]$/g, '')
const loopback = address => {
  try { return ipaddr.process(address).range() === 'loopback' } catch { return false }
}
// ipaddr.js calls ::/96 unicast, but these deprecated IPv4-compatible addresses
// embed an IPv4 target that some stacks still route.
const IPV4_COMPATIBLE = ipaddr.parseCIDR('::/96')
function publicAddress (address) {
  try {
    const ip = ipaddr.process(address)
    if (ip.kind() === 'ipv6' && ip.match(IPV4_COMPATIBLE)) return false
    return ip.range() === 'unicast'
  } catch { return false }
}

function endpoint (value, { origins = [], allowLoopback = false } = {}) {
  let url
  try { url = new URL(value) } catch { throw denied('Model endpoint must be a valid HTTPS URL') }
  const host = hostname(url)
  const local = allowLoopback && net.isIP(host) && loopback(host)
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw denied('Model endpoint must use HTTPS')
  if (url.username || url.password || url.search || url.hash) throw denied('Model endpoint cannot contain credentials, query or fragment')
  if (!origins.includes(url.origin)) throw denied('Model endpoint origin is not in MODEL_ALLOWED_ORIGINS')
  if (net.isIP(host) && !publicAddress(host) && !local) throw denied('Model endpoint must use a public address')
  if (!net.isIP(host) && /(?:^localhost$|\.localhost$|\.local$|\.internal$|\.svc$|\.cluster\.local$)/i.test(host)) {
    throw denied('Model endpoint must use a public hostname')
  }
  return url
}

function validatedLookup ({ lookup = dns.lookup.bind(dns) } = {}) {
  return (host, options, callback) => {
    Promise.resolve().then(() => lookup(host, { all: true, verbatim: true })).then(addresses => {
      if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
        throw denied('Model endpoint DNS returned a private or special-use address')
      }
      if (options?.all) callback(null, addresses)
      else callback(null, addresses[0].address, addresses[0].family)
    }).catch(callback)
  }
}

function modelRequest (base, payload, { apiKey, signal, origins = [], allowLoopback = false, endpointMode = 'base',
  maxBytes = MAX_RESPONSE_BYTES, lookup, request } = {}) {
  const url = endpoint(base, { origins, allowLoopback })
  if (endpointMode === 'base') {
    const basePath = url.pathname.replace(/\/+$/, '')
    url.pathname = basePath + (basePath.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions')
  } else if (endpointMode !== 'full') throw denied('Unsupported model endpoint mode')
  const body = JSON.stringify(payload)
  const send = request || (url.protocol === 'https:' ? https.request : http.request)
  return new Promise((resolve, reject) => {
    const req = send(url, { method: 'POST', agent: false, signal,
      lookup: validatedLookup({ lookup }),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity',
        'Content-Length': Buffer.byteLength(body), ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }
    }, res => {
      const fail = error => { res.destroy(); req.destroy(); reject(error) }
      if (res.statusCode < 200 || res.statusCode >= 300) return fail(new Error(`Model endpoint returned HTTP ${res.statusCode}`))
      if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(res.headers['content-type'] || '')) return fail(new Error('Model response must be JSON'))
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') return fail(new Error('Compressed model responses are not accepted'))
      if (Number(res.headers['content-length']) > maxBytes) return fail(new Error('Model response exceeds byte limit'))
      const chunks = []
      let bytes = 0
      res.on('data', chunk => {
        bytes += chunk.length
        if (bytes > maxBytes) return fail(new Error('Model response exceeds byte limit'))
        chunks.push(chunk)
      })
      res.on('error', reject)
      res.on('aborted', () => reject(new Error('Model response aborted')))
      res.on('end', () => {
        try {
          let data
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (_) { throw new Error('Model response is not valid JSON') }
          const choice = data?.choices?.[0]
          if (choice?.finish_reason != null && choice.finish_reason !== 'stop') throw new Error('Model response did not complete')
          const text = choice?.message?.content
          if (typeof text !== 'string') throw new Error('Model response has no message content')
          if (!text.trim()) throw new Error('Model response has empty message content')
          let result
          try { result = JSON.parse(text) } catch (_) { throw new Error('Model message content is not valid JSON') }
          if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Model result must be a JSON object')
          resolve(result)
        } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.setTimeout(120000, () => req.destroy(new Error('Model endpoint timed out')))
    req.end(body)
  })
}

module.exports = { endpoint, publicAddress, validatedLookup, modelRequest, MAX_RESPONSE_BYTES }
