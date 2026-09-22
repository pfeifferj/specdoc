const { esc } = require('./prosediff')

const input = (name, value) => `<input type="hidden" name="${name}" value="${esc(value == null ? '' : value)}">`
const anchor = namespace => 'amendments-' + String(namespace).toLowerCase().replace(/[^a-z0-9]/g, '-')

const REASONS = {
  'not-approver': 'Only project approvers and board admins can change this.',
  'roles-unavailable': "The project's approver list could not be read just now, so this cannot be changed here. Try again shortly.",
  // A viewer this row withholds the switch from may still be allowed to flip
  // it: the POST re-reads the roles file and a board admin passes whatever it
  // says. So this sentence names the unknown, not a refusal.
  'bot-unknown': 'That value is the saved preference. The review bot binding in <code>.specs/roles.yml</code> could not be read just now, so what it would do is unknown. Reload to change it.'
}
// Both of these come from one failed read of the roles file, which carries the
// bot binding as well as the approver list.
const UNREADABLE = new Set(['roles-unavailable', 'bot-unknown'])

function feedbackSettings (csrf, rows) {
  if (!rows || !rows.length) return ''
  return `<section class="panel feedback-settings" id="amendments"><h2>Spec amendments from code review</h2>
  <p>After a linked implementation pull request merges, the review bot proposes spec changes as suggestions in the note. Turning this off stops collection and generation.</p>
  ${rows.map(row => {
    // Every row the service builds names its cause; a row without one is read
    // as a viewer who cannot act, which is the only cause that reaches the page
    // without a failed read behind it.
    const reason = row.reason || 'not-approver'
    // With the binding unknown the row falls back to the stored preference
    // rather than reporting no bot and a disabled feature.
    const unknownBot = UNREADABLE.has(reason)
    const unbound = !row.configured && !unknownBot
    // One slot order on every shape: the value in force, then the cause, then
    // what to do about it. The setting is one shared row per project
    // (spec_board_feedback_settings), so no sentence calls it the viewer's.
    // With no bot bound nothing is proposed whatever the switch says, so the
    // slot reads off and the stored preference follows it. An unknown binding
    // leaves the value in force unknowable, so that row prints the stored one
    // and the bot-unknown sentence says which of the two it is.
    const state = `Automatic spec amendment proposals: ${row.enabled && !unbound ? 'on' : 'off'}.`
    const cause = REASONS[reason] || ''
    const bots = row.admin ? '<a href="/bots">Review bots</a>' : 'Review bots'
    const bind = `A project approver adds <code>feedback-bot: &lt;bot name&gt;</code> to <code>.specs/roles.yml</code>, and a board admin adds the bot on ${bots}.`
    // With the preference on and no bot bound, the stored value and the running
    // state differ, so the row names both. With it off they agree, and the
    // binding is still worth stating because flipping the switch alone starts
    // nothing. "Paused" belongs to the switch being off, on /statusz and in
    // docs/operations.md, so the no-bot state takes a word of its own.
    const idle = row.enabled
      ? "Not running: no review bot is bound to this project, so nothing is proposed. The project's saved preference is on."
      : 'No review bot is bound to this project, so turning the preference on alone would propose nothing.'
    const body = unbound
      ? `<p>${state} ${idle} ${bind}</p>`
      : row.manageable && row.configured
        ? `<p>${state} This is one setting for the whole project.</p><form method="post" action="/feedback/settings">${input('csrf', csrf)}${input('namespace', row.namespace)}
      <label class="check"><input type="checkbox" name="enabled" value="on"${row.enabled ? ' checked' : ''}> Automatic spec amendment proposals</label>
      <p class="meta">This saves the amendment setting only. Email preferences above have their own Save.</p>
      <button type="submit">Save amendment settings</button></form>`
        : `<p>${state}${cause ? ' ' + cause : ''}</p>`
    return `<div><h3 id="${anchor(row.namespace)}">${esc(row.namespace)}</h3>${body}</div>`
  }).join('')}
  </section>`
}

module.exports = { feedbackSettings }
