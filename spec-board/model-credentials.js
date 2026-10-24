const crypto = require('crypto')

function secretKey (value = process.env.SPECDOC_SECRET_KEY) {
  if (!value) throw new Error('SPECDOC_SECRET_KEY is required for stored model credentials')
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('SPECDOC_SECRET_KEY must be 32 random bytes encoded as base64')
  return key
}

function encryptSecret (value, identity, key = secretKey()) {
  if (!value) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`specdoc:model-key:v1:${identity}`))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.')
}

function decryptSecret (value, identity, key) {
  if (!value) return null
  if (!value.startsWith('v1.')) throw new Error('Legacy model key must be encrypted by the secret migration before use')
  const parts = value.split('.')
  if (parts.length !== 4) throw new Error('Invalid encrypted model credential')
  const [, iv, tag, ciphertext] = parts.map((part, i) => i ? Buffer.from(part, 'base64url') : part)
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted model credential')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key || secretKey(), iv)
  decipher.setAAD(Buffer.from(`specdoc:model-key:v1:${identity}`))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

async function migrateSecrets (db) {
  if (!process.env.SPECDOC_SECRET_KEY) return
  const key = secretKey()
  const { rows } = await db.query("SELECT name, api_key FROM spec_board_bots WHERE api_key IS NOT NULL AND api_key NOT LIKE 'v1.%'")
  for (const row of rows) await db.query('UPDATE spec_board_bots SET api_key=$2 WHERE name=$1 AND api_key=$3',
    [row.name, encryptSecret(row.api_key, row.name, key), row.api_key])
}

module.exports = { secretKey, encryptSecret, decryptSecret, migrateSecrets }
