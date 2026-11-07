const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{70,255}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/]
]

function credentialKinds (value) {
  return patterns.filter(([, pattern]) => pattern.test(String(value))).map(([kind]) => kind)
}

function assertNoCredentials (value) {
  const kinds = credentialKinds(value)
  if (kinds.length) throw Object.assign(new Error(`Possible ${kinds.join(', ')} in content; remove and rotate credentials before publishing or external review`), { code: 'SENSITIVE_CONTENT' })
}

module.exports = { credentialKinds, assertNoCredentials }
