const assert = require('assert/strict')
const crypto = require('crypto')
const { encryptSecret, decryptSecret, migrateSecrets, verifySecrets } = require('./model-credentials')

async function main () {
  const original = process.env.SPECDOC_SECRET_KEY
  let rows = [], writes = 0
  const db = { query: async (sql, values) => {
    if (sql.startsWith('SELECT')) return { rows }
    writes++
    const row = rows.find(row => row.name === values[0] && row.api_key === values[2])
    if (row) row.api_key = values[1]
    return { rowCount: row ? 1 : 0 }
  } }
  try {
    delete process.env.SPECDOC_SECRET_KEY
    await migrateSecrets(db)
    await verifySecrets(db)
    rows = [{ name: 'reviewer', api_key: 'fixture-provider-key' }]
    await assert.rejects(migrateSecrets(db), /SPECDOC_SECRET_KEY is required/)
    await assert.rejects(verifySecrets(db), /SPECDOC_SECRET_KEY is required/)
    assert.equal(writes, 0, 'missing encryption credentials cannot partially migrate model keys')
    process.env.SPECDOC_SECRET_KEY = 'invalid'
    await assert.rejects(migrateSecrets(db), /32 random bytes/)
    process.env.SPECDOC_SECRET_KEY = crypto.randomBytes(32).toString('base64')
    await assert.rejects(verifySecrets(db), /migration before use/)
    await migrateSecrets(db)
    assert.equal(decryptSecret(rows[0].api_key, 'reviewer'), 'fixture-provider-key')
    await verifySecrets(db)
    await migrateSecrets(db)
    assert.equal(writes, 1, 'repeating a migration preserves the encrypted credential')
    rows.push({ name: 'another', api_key: encryptSecret('second-key', 'another') })
    rows.unshift({ name: 'pending', api_key: 'not-yet-encrypted' })
    process.env.SPECDOC_SECRET_KEY = crypto.randomBytes(32).toString('base64')
    await assert.rejects(verifySecrets(db))
    await assert.rejects(migrateSecrets(db))
    assert.equal(writes, 1, 'a wrong key cannot rewrite stored ciphertext')
  } finally {
    if (original === undefined) delete process.env.SPECDOC_SECRET_KEY
    else process.env.SPECDOC_SECRET_KEY = original
  }
  console.log('model credential migration and startup prerequisites passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
