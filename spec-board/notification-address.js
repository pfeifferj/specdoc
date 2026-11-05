'use strict'

function verifiedEmails (raw) {
  let profile
  try { profile = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return [] }
  if (profile?.provider !== 'github' || !/^[1-9]\d{0,19}$/.test(String(profile.id || '')) || !Array.isArray(profile.emails)) return []
  return profile.emails.filter(entry => entry?.verified === true && typeof entry.value === 'string' &&
    entry.value.length <= 254 && /^[^\s@<>(),;:\\"]+@[^\s@<>(),;:\\"]+$/.test(entry.value))
    .sort((a, b) => Number(b.primary === true) - Number(a.primary === true))
    .map(entry => entry.value.toLowerCase())
}

function notificationEmail (user) {
  const verified = verifiedEmails(user.profile)
  const preferred = typeof user.email === 'string' ? user.email.trim().toLowerCase() : ''
  return verified.includes(preferred) ? preferred : verified[0] || ''
}

async function verifiedRecipient (db, email) {
  if (typeof email !== 'string' || !email || email.length > 254) return false
  const address = email.toLowerCase()
  const pattern = '%' + address.replace(/[\\%_]/g, '\\$&') + '%'
  const { rows } = await db.query('SELECT profile FROM "Users" WHERE profile ILIKE $1 LIMIT 100', [pattern])
  return rows.some(row => verifiedEmails(row.profile).includes(address))
}

module.exports = { verifiedEmails, notificationEmail, verifiedRecipient }
