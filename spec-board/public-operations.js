const crypto = require('crypto')

const RETENTION_MS = 7 * 86400000
const validKey = key => typeof key === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)
const fail = (status, message) => Object.assign(new Error(message), { status })
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function migrate (db) {
  await db.query(`CREATE TABLE IF NOT EXISTS spec_board_operations (
    actor text NOT NULL, key uuid NOT NULL, fingerprint text NOT NULL,
    note_id text NOT NULL, note_uuid uuid REFERENCES "Notes"(id) ON DELETE SET NULL, endpoint text NOT NULL,
    prepared jsonb, result jsonb, status integer, expired boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
    PRIMARY KEY (actor, key)
  )`)
  await db.query('CREATE INDEX IF NOT EXISTS spec_board_operations_note ON spec_board_operations(note_uuid)')
  await db.query('CREATE INDEX IF NOT EXISTS spec_board_operations_expiry ON spec_board_operations(expires_at) WHERE NOT expired')
  await db.query(`CREATE OR REPLACE FUNCTION spec_board_forget_deleted_operation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE spec_board_operations SET prepared=NULL, result=NULL, expired=true WHERE note_uuid=OLD.id;
      RETURN OLD;
    END $$`)
  await db.query('DROP TRIGGER IF EXISTS spec_board_forget_deleted_operation ON "Notes"')
  await db.query(`CREATE TRIGGER spec_board_forget_deleted_operation BEFORE DELETE ON "Notes"
    FOR EACH ROW EXECUTE FUNCTION spec_board_forget_deleted_operation()`)
  await expire(db)
}

async function expire (db) {
  await db.query(`UPDATE spec_board_operations SET prepared=NULL, result=NULL, expired=true
    WHERE NOT expired AND expires_at <= now()`)
}

function createOperations ({ db, mutate }) {
  async function read (client, actor, key) {
    const { rows: [row] } = await client.query('SELECT * FROM spec_board_operations WHERE actor=$1 AND key=$2', [actor, key])
    return row
  }

  async function locked (actor, key, fn) {
    const lock = BigInt.asIntN(64, BigInt('0x' + fingerprint([actor, key]).slice(0, 16))).toString()
    let lost = false
    let client
    const onError = () => { lost = true }
    const deadline = Date.now() + 5000
    while (!client && Date.now() < deadline) {
      const candidate = await db.connect()
      candidate.on('error', onError)
      try {
        const { rows: [row] } = await candidate.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [lock])
        if (row.acquired) client = candidate
        else {
          candidate.removeListener('error', onError)
          candidate.release()
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      } catch (error) {
        candidate.removeListener('error', onError)
        candidate.release(true)
        throw error
      }
    }
    if (!client) throw Object.assign(fail(409, 'Operation is still in progress; query its receipt or retry with the same key'), { code: 'OPERATION_PENDING' })
    try {
      return await fn(client, () => {
        if (lost) throw fail(503, 'Operation lock connection was lost; query the receipt before retrying')
      })
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [lock])
        client.release(lost)
      } catch (_) { client.release(true) }
      client.removeListener('error', onError)
    }
  }

  function checkExpired (row) {
    if (row.expired || +new Date(row.expires_at) <= Date.now()) throw fail(410, 'Operation receipt expired; this key cannot be reused')
  }

  async function get ({ actor, key, authorize }) {
    if (!validKey(key)) throw fail(400, 'Operation key must be a UUID')
    const row = await read(db, actor, key)
    if (!row) throw fail(404, 'Unknown operation')
    await authorize(row.note_id)
    await expire(db)
    checkExpired(row)
    return {
      key, state: row.status == null ? 'pending' : row.status < 400 ? 'completed' : 'failed',
      status: row.status, result: row.result, expiresAt: row.expires_at
    }
  }

  async function run ({ actor, key, requestFingerprint, noteId, endpoint, authorize, prepare }) {
    if (!validKey(key)) throw fail(400, 'Idempotency-Key must be a UUID')
    key = key.toLowerCase()
    return locked(actor, key, async (client, checkLock) => {
      let row = await read(client, actor, key)
      await authorize(row ? row.note_id : noteId)
      await expire(client)
      if (row) {
        if (row.fingerprint !== requestFingerprint) throw fail(409, 'Operation key was used for another request')
        checkExpired(row)
      } else {
        const prepared = await prepare(client)
        checkLock()
        const { rows: [created] } = await client.query(`INSERT INTO spec_board_operations
          (actor,key,fingerprint,note_id,note_uuid,endpoint,prepared,expires_at)
          SELECT $1,$2,$3,shortid,id,$5,$6,$7 FROM "Notes" WHERE shortid=$4
          RETURNING *`, [actor, key, requestFingerprint, noteId, endpoint, prepared, new Date(Date.now() + RETENTION_MS)])
        if (!created) throw fail(404, 'Unknown spec')
        row = created
      }
      if (row.status != null) return { status: row.status, result: row.result, replayed: true }
      checkLock()
      let status = 200
      let result = row.prepared.result
      try {
        if (row.prepared.mutation) await mutate(row.prepared.mutation)
      } catch (error) {
        if (![400, 403, 404, 409, 412, 428].includes(error.status)) throw error
        // Busy failures are retryable with the same immutable mutation.
        if (error.status === 409) throw error
        status = error.status
        result = { error: 'Editor refused the prepared operation', key }
      }
      checkLock()
      const { rowCount } = await client.query(`UPDATE spec_board_operations
        SET prepared=NULL, result=$3, status=$4, expires_at=$5
        WHERE actor=$1 AND key=$2 AND NOT expired`, [actor, key, result, status, new Date(Date.now() + RETENTION_MS)])
      if (!rowCount) throw fail(404, 'Unknown spec')
      await authorize(noteId)
      return { status, result, replayed: false }
    })
  }
  return { get, run }
}

module.exports = { migrate, expire, createOperations, validKey, fingerprint, RETENTION_MS }
