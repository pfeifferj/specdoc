'use strict'

const crypto = require('crypto')
const { governance } = require('./security-identities')

const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
const canonical = value => JSON.stringify(stable(value))
const sortedRefs = refs => (refs || []).map(stable).sort((a, b) => canonical(a).localeCompare(canonical(b)))
const publicPermission = permission => ['freely', 'editable', 'locked'].includes(permission)

function policyHash (roles) {
  const policy = governance(roles)
  if (!policy) return null
  return digest(canonical({ format: 1, roles, approvers: policy.approvers.map(p => p.subject).sort(), authors: policy.authors.map(p => p.subject).sort() }))
}

function candidate (spec, rawBody) {
  const policy = policyHash(spec.roles)
  const value = { format: 1, noteId: spec.id, namespace: spec.namespace, title: spec.title,
    owner: spec.ownerSubject || null, area: spec.category || '', kind: spec.topLevel ? 'top-level' : '',
    dependsOn: sortedRefs(spec.dependsOn), supersedes: spec.supersedes || null,
    public: publicPermission(spec.permission), policy, body: rawBody }
  return { hash: digest(canonical(value)), policy, value }
}

function publicationDocument (body, metadata) {
  return `<!-- specdoc-publication:${Buffer.from(canonical(metadata)).toString('base64url')} -->\n\n${body}`
}

function publicationMetadata (text) {
  const match = /^<!-- specdoc-publication:([A-Za-z0-9_-]{1,32768}) -->\n\n/.exec(text || '')
  if (!match) return null
  try {
    const meta = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'))
    if (meta.format !== 1 || typeof meta.noteId !== 'string' || typeof meta.namespace !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(meta.submission || '') || !/^[0-9a-f]{64}$/.test(meta.candidate || '') ||
        !/^[0-9a-f]{64}$/.test(meta.bodyHash || '') || digest(text.slice(match[0].length)) !== meta.bodyHash) return null
    return meta
  } catch { return null }
}

function receiptMatches (receipt, intent, namespace, noteId) {
  const meta = receipt && publicationMetadata(receipt.body)
  return !!(meta && intent && !intent.redacted_at && receipt.state === 'merged' && receipt.commit && meta.submission === intent.id &&
    intent.path && intent.pr_number && intent.base_branch && receipt.path === intent.path &&
    receipt.number === intent.pr_number && receipt.base === intent.base_branch && receipt.namespace === namespace &&
    meta.noteId === noteId && meta.namespace === namespace && intent.note_id === noteId && intent.namespace === namespace &&
    meta.candidate === intent.candidate_hash && digest(receipt.body) === intent.document_hash &&
    canonical(meta.relations) === canonical(intent.relations))
}

module.exports = { canonical, digest, candidate, policyHash, publicPermission, publicationDocument, publicationMetadata, receiptMatches }
