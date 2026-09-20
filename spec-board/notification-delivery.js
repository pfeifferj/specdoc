const { dueRecipients, visibleNotifications, notificationQueueStatus } = require('./notification-store')
const { createHealthState } = require('./health-state')

function createNotificationDelivery ({ db, mailer, renderDigest, emailKey, emailFooter, unsubUrl, from,
  debounceMinutes, shouldStop = () => false, health = createHealthState(), now = Date.now,
  maxRecipients = 8, rowLimit = 200, budgetMs = 5000 }) {
  let flushing = null
  const recipientLimit = Math.max(1, Math.min(100, maxRecipients))
  const batchLimit = Math.max(1, Math.min(1000, rowLimit))
  const status = () => health.get('mail')
  async function run () {
    if (!mailer || shouldStop()) return status()
    const started = now()
    let attempted = 0, completed = 0, sent = 0, dropped = 0, failed = false
    try {
      const dead = await db.query(`DELETE FROM spec_board_notifications WHERE id IN
        (SELECT id FROM spec_board_notifications WHERE attempts >= 20 ORDER BY id LIMIT $1)`, [recipientLimit * batchLimit])
      dropped = dead.rowCount
      if (dropped) {
        failed = true
        health.failure('mail', 'DeliveryExhausted', { dropped: (status().dropped || 0) + dropped })
      }
      const due = await dueRecipients(db, debounceMinutes, recipientLimit)
      for (const { email } of due) {
        if (shouldStop() || now() - started >= budgetMs) break
        let captured = []
        try {
          // Backlogged recipients move behind untouched recipients even when a
          // successful capped batch leaves older rows queued for another pass.
          await db.query('UPDATE spec_board_notifications SET last_attempt_at = now() WHERE email = $1', [email])
          const { rows } = await db.query(`SELECT id, note_id, title, line, event, created_at FROM spec_board_notifications
            WHERE email = $1 ORDER BY created_at, id LIMIT $2`, [email, batchLimit])
          if (!rows.length) continue
          captured = rows.map(row => row.id)
          attempted++
          const { rows: opt } = await db.query('SELECT 1 FROM spec_board_optout WHERE email_hash = $1', [emailKey(email)])
          const visible = opt.length ? [] : await visibleNotifications(db, rows)
          if (visible.length) {
            if (shouldStop()) break
            const unsub = unsubUrl(email)
            const { subject, text } = renderDigest(visible, emailFooter(email, unsub))
            await mailer.sendMail({ from, to: email, subject, text,
              headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } })
            sent++
          }
          await db.query('DELETE FROM spec_board_notifications WHERE id = ANY($1)', [captured])
          completed++
        } catch (error) {
          failed = true
          health.failure('mail', error)
          if (captured.length) {
            await db.query('UPDATE spec_board_notifications SET attempts = attempts + 1 WHERE id = ANY($1)', [captured])
              .catch(error => health.failure('mail', error))
          }
        }
      }
      const queue = await notificationQueueStatus(db)
      const details = { ...queue, enabled: true, lastBatch: { attempted, sent, dropped },
        oldestAgeSeconds: queue.oldestAt ? Math.max(0, Math.floor((now() - Date.parse(queue.oldestAt)) / 1000)) : 0 }
      if (!failed && completed && !queue.failing) health.success('mail', details)
      else if (queue.failing && status().ok !== false) health.failure('mail', 'DeliveryPendingRetry', details)
      else health.observe('mail', details)
    } catch (error) {
      health.failure('mail', error, { enabled: true })
    }
    return status()
  }
  function flush () {
    if (!flushing) flushing = run().finally(() => { flushing = null })
    return flushing
  }
  health.observe('mail', { enabled: !!mailer, queued: null, oldestAt: null, oldestAgeSeconds: null })
  return { flush, status }
}

module.exports = { createNotificationDelivery }
