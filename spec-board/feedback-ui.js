const { esc } = require('./prosediff')

function href (value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? esc(url.href) : ''
  } catch { return '' }
}

const input = (name, value) => `<input type="hidden" name="${name}" value="${esc(value == null ? '' : value)}">`
const link = (url, title) => href(url) ? `<a href="${href(url)}" rel="noopener noreferrer">${esc(title)}</a>` : esc(title)
const states = { pending: 'Awaiting decision', stale: 'Needs another look', accepted: 'Accepted for editing', dismissed: 'Dismissed', incorporated: 'Reported incorporated' }

function feedbackSettings (csrf, rows) {
  if (!rows || !rows.length) return ''
  return `<section class="panel feedback-settings"><h2>Spec amendments from code review</h2>
  <p>Generate proposed spec changes after linked implementation pull requests merge. Turning this off pauses automatic proposals and keeps existing decisions. You can still import a pull request.</p>
  ${rows.map(row => `<div><h3>${esc(row.namespace)}</h3>${row.manageable && row.configured
    ? `<form method="post" action="/feedback/settings">${input('csrf', csrf)}${input('namespace', row.namespace)}
      <label class="check"><input type="checkbox" name="enabled" value="on"${row.enabled ? ' checked' : ''}> Automatic spec amendment proposals</label>
      <button type="submit">Save</button></form>`
    : `<p>Automatic spec amendment proposals: ${row.configured && row.enabled ? 'on' : 'off'}.</p>`}
    ${row.configured ? '' : `<p>A project approver needs to choose a review bot in the project's review configuration before proposals can be generated. Saved preference: ${row.enabled ? 'on' : 'off'}.</p>`}</div>`).join('')}
  <p><a href="/feedback">Review proposed amendments</a></p></section>`
}

function proposalHtml (p, csrf) {
  const fields = action => input('csrf', csrf) + input('id', p.id) + input('version', p.version) + input('action', action)
  const form = (action, label, extra = '') => `<form method="post" action="/feedback">${fields(action)}${extra}<button type="submit"${action === 'accept' || action === 'incorporate' ? ' class="primary"' : ''}>${label}</button></form>`
  const repo = p.sourceRepo || (p.job && p.job.repo)
  const number = p.sourceNumber || (p.job && p.job.number)
  const source = repo && Number.isSafeInteger(Number(number)) && Number(number) > 0
    ? link(`https://github.com/${repo}/pull/${Number(number)}`, `${repo}#${Number(number)}`) : 'Source discussion'
  const canonical = p.canonical || {}
  const evidence = p.evidence || {}
  const group = Array.isArray(evidence.groups) && evidence.groups.find(g => g.id === p.groupId)
  const entries = group && Array.isArray(group.entries) ? group.entries : []
  const audit = Array.isArray(p.audit) ? p.audit : []
  const decision = audit.length ? audit[audit.length - 1] : p.decision || {}
  const actor = p.decidedBy || decision.login || (decision.actor && (decision.actor.login || decision.actor)) || ''
  const at = p.decidedAt || decision.at || decision.createdAt || ''
  const incorporationEvent = [...audit].reverse().find(a => a.action === 'incorporate' || a.action === 'incorporated')
  const incorporation = p.incorporation || (incorporationEvent && incorporationEvent.extra) || null
  const reason = decision.extra && decision.extra.reason
  const stale = p.stale || p.status === 'stale'
  const mayAct = p.canTriage !== false
  const pending = p.status === 'pending' && !stale && !p.editorChanged
  return `<article class="feedback-proposal" id="proposal-${esc(p.id)}">
    <h2>${esc(p.targetTitle || p.title || p.targetNote || 'Spec amendment')}</h2>
    <p class="meta"><span class="badge${p.status === 'accepted' || p.status === 'incorporated' ? ' success' : stale ? ' warning' : ''}">${esc(states[p.status] || p.status || 'Awaiting decision')}</span><span>${source}${actor ? ` · ${esc(actor)}` : ''}${at ? ` · ${esc(at)}` : ''}</span></p>
    ${stale ? '<p class="feedback-warning">The source discussion or spec has changed. Reconsider this proposal against the current text before accepting it.</p>' : ''}
    ${p.editorChanged ? '<p class="feedback-warning">The spec editor has changed since this proposal was prepared. Reconsider it against the current text before accepting.</p>' : ''}
    ${reason ? `<p>Decision reason: ${esc(reason)}</p>` : ''}
    <p>${esc(p.rationale || 'The proposal text is no longer retained. Its decision remains on record.')}</p>
    ${p.generalization ? `<p><strong>Why this applies more widely:</strong> ${esc(p.generalization)}</p>` : ''}
    ${p.anchor ? `<p>In ${esc(p.anchor)}</p>` : ''}
    ${p.quote ? `<details><summary>Current wording in the reviewed spec version</summary><blockquote>${esc(p.quote)}</blockquote></details>` : ''}
    ${p.amendment ? `<div class="feedback-amendment"><label>Proposed wording<textarea readonly rows="7">${esc(p.amendment)}</textarea></label><button type="button" class="feedback-copy">Copy amendment</button><span class="feedback-copy-status" role="status"></span></div>` : ''}
    ${canonical.commit ? `<p class="meta">Spec version reviewed: ${esc(canonical.commit.slice(0, 12))}${canonical.path ? ` · ${esc(canonical.path)}` : ''}.</p>` : ''}
    ${p.editorHash && canonical.hash && p.editorHash !== canonical.hash ? '<p>The editor had changes beyond this published version. Reconcile those changes when editing.</p>' : ''}
    ${p.editorDiff ? `<details><summary>Changes already in the editor</summary><pre>${esc(p.editorDiff)}</pre></details>` : ''}
    ${entries.length ? `<details><summary>Source discussion</summary>${entries.map(e => `<blockquote><p>${esc(e.body || '')}</p><footer>${link(e.url, e.author || e.id || 'Review comment')}</footer></blockquote>`).join('')}</details>`
      : Array.isArray(p.sources) && p.sources.length ? `<details><summary>Source quotations</summary>${p.sources.map(s => `<blockquote>${esc(s.quote || '')}<footer>${link(s.url, s.id || 'Review comment')}</footer></blockquote>`).join('')}</details>` : ''}
    ${p.finalEvidence ? `<details><summary>Implementation evidence</summary><p>${esc(p.finalEvidence.path)}</p><pre>${esc(p.finalEvidence.quote)}</pre></details>` : ''}
    ${p.noteUrl ? `<p>${link(p.noteUrl, 'Open spec')}</p>` : ''}
    ${p.status === 'accepted' ? `<p>Acceptance records your intent to edit. The note owner should return the spec to <code>in-review</code> before applying or adapting this wording, then use the usual review and approval process.</p>` : ''}
    ${mayAct ? `<div class="feedback-actions">${pending ? form('accept', 'Accept for editing') : ''}
      ${['pending', 'stale'].includes(p.status) ? form('dismiss', 'Dismiss', '<label>Reason (optional)<input name="reason" maxlength="1000"></label>') : ''}
      ${['pending', 'stale', 'dismissed', 'accepted', 'incorporated'].includes(p.status) || stale || p.editorChanged ? form('reconsider', 'Reconsider') : ''}
      ${p.status === 'accepted' ? form('incorporate', 'Mark incorporated', `<p>Record the merged spec revision. This records your assessment that it incorporates the lesson.</p><label>Spec repository<input name="repo" value="${esc(p.targetNamespace || '')}" required></label><label>Revision pull request number<input name="number" type="number" min="1" required></label>`) : ''}</div>` : ''}
    ${incorporation ? `<p>Incorporation: ${link(incorporation.url, incorporation.repo ? `${incorporation.repo}#${incorporation.number}` : 'Spec revision')}.</p>` : ''}
  </article>`
}

function feedbackPage ({ csrf, proposals = [], namespace = '', namespaces = [], problems = [], notice, error, settings, nextUrl }) {
  const options = namespaces.map(ns => typeof ns === 'string' ? { namespace: ns, label: ns } : { ...ns, label: ns.label || ns.namespace })
  return `<div class="page-heading"><div><h1>Proposals</h1><p class="context">Suggested spec amendments from implementation reviews. Accept a proposal to record your intent to edit; the spec changes when someone updates it.</p></div><span class="badge">${proposals.length} ${proposals.length === 1 ? 'proposal' : 'proposals'}</span></div>
  ${namespace ? `<p class="meta">${esc(namespace)} <a href="/feedback">All namespaces</a></p>` : ''}
  ${notice ? `<p class="notice" role="status">${esc(notice)}</p>` : ''}${error ? `<p class="feedback-error" role="alert">${esc(error)}</p>` : ''}
  ${problems.length ? `<section class="panel"><h2>Needs attention</h2><p>These pull requests could not be reviewed. Resolve the reported issue, then retry the import.</p>
    ${problems.map(problem => {
      const valid = typeof problem.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(problem.repo) &&
        Number.isSafeInteger(problem.number) && problem.number > 0
      return `<article><h3>${valid ? link(`https://github.com/${problem.repo}/pull/${problem.number}`, `${problem.repo}#${problem.number}`) : esc(problem.repo || 'Pull request')}</h3>
        <p>${esc(problem.namespace || '')}: ${esc(problem.error || 'Review evidence is unavailable.')}</p>
        ${problem.nextAt ? `<p>Next automatic attempt: ${esc(problem.nextAt)}.</p>` : ''}
        ${valid ? `<form method="post" action="/feedback">${input('csrf', csrf)}${input('action', 'import')}${input('namespace', problem.namespace)}${input('repo', problem.repo)}${input('number', problem.number)}<button type="submit">Retry import</button></form>` : ''}</article>`
    }).join('')}</section>` : ''}
  <details class="disclosure feedback-import"><summary>Import a pull request</summary>
    <form method="post" action="/feedback">${input('csrf', csrf)}${input('action', 'import')}
    <label>Spec project<select name="namespace" required>${options.map(ns => `<option value="${esc(ns.namespace)}">${esc(ns.label)}</option>`).join('')}</select></label>
    <label>Implementation repository<input name="repo" placeholder="owner/repository" required></label>
    <label>Pull request number<input name="number" type="number" min="1" required></label>
    <button type="submit" class="primary"${options.length ? '' : ' disabled'}>Import</button></form>
    <p>Import a merged implementation pull request whose description links its specs.</p></details>
  ${settings ? feedbackSettings(csrf, settings) : ''}
  ${proposals.length ? proposals.map(p => proposalHtml(p, csrf)).join('') : '<div class="empty-state"><h2>No amendment proposals to review</h2><p>New proposals appear here after linked implementation reviews, or you can import a pull request above.</p></div>'}
  ${typeof nextUrl === 'string' && nextUrl.startsWith('/feedback?') ? `<p><a href="${esc(nextUrl)}" rel="next">Older proposals</a></p>` : ''}
  <script>
    document.querySelectorAll('.feedback-copy').forEach(function (button) {
      button.addEventListener('click', function () {
        var box = button.parentElement.querySelector('textarea');
        var status = button.parentElement.querySelector('.feedback-copy-status');
        box.focus(); box.select();
        if (navigator.clipboard) navigator.clipboard.writeText(box.value).then(function () { status.textContent = ' Copied'; }, function () { status.textContent = ' Selected; copy with your keyboard'; });
        else status.textContent = ' Selected; copy with your keyboard';
      });
    });
  </script>`
}

module.exports = { feedbackPage, feedbackSettings }
