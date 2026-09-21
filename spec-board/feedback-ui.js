const { esc } = require('./prosediff')

const input = (name, value) => `<input type="hidden" name="${name}" value="${esc(value == null ? '' : value)}">`
const anchor = namespace => 'amendments-' + String(namespace).toLowerCase().replace(/[^a-z0-9]/g, '-')

function feedbackSettings (csrf, rows) {
  if (!rows || !rows.length) return ''
  return `<section class="panel feedback-settings" id="amendments"><h2>Spec amendments from code review</h2>
  <p>After a linked implementation pull request merges, the review bot proposes spec changes as suggestions in the note. Turning this off pauses collection and generation.</p>
  ${rows.map(row => `<div><h3 id="${anchor(row.namespace)}">${esc(row.namespace)}</h3>${row.manageable && row.configured
    ? `<form method="post" action="/feedback/settings">${input('csrf', csrf)}${input('namespace', row.namespace)}
      <label class="check"><input type="checkbox" name="enabled" value="on"${row.enabled ? ' checked' : ''}> Automatic spec amendment proposals</label>
      <p class="meta">This saves the amendment setting only. Email preferences above have their own Save.</p>
      <button type="submit">Save amendment settings</button></form>`
    : `<p>Automatic spec amendment proposals: ${row.configured && row.enabled ? 'on' : 'off'}.</p>`}
    ${row.configured ? '' : `<p>A project approver needs to choose a review bot in the project's review configuration before proposals can be generated. Saved preference: ${row.enabled ? 'on' : 'off'}.</p>`}</div>`).join('')}
  </section>`
}

module.exports = { feedbackSettings }
