(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
  const plural = (value, noun) => `${count(value)} ${noun}${value === 1 ? '' : 's'}`
  const warning = text => `<p class="warn">${esc(text)}</p>`

  function link (url, title) {
    const href = String(url ?? '')
    const safe = /^(?:https?:\/\/|\/(?!\/))/i.test(href) && !/[\\\u0000-\u0020\u007f]/.test(href)
    return safe ? `<a href="${esc(href)}">${esc(title)}</a>` : esc(title)
  }

  function renderConsistencyResult (result, error) {
    const saved = count(result?.saved) ? ` This run already created ${plural(result.saved, 'shared discussion')}.` : ''
    if (error || result?.error) return warning(`${error || result.error}${saved}`)
    if (!result) return ''
    if (result.stale) return warning(`The specs or review configuration changed after this review started.${saved} Run review again to compare the current text.`)
    const omitted = Array.isArray(result.omitted) ? result.omitted : []
    const omissions = omitted.length
      ? `<p>${plural(omitted.length, 'spec')} exceeded the context limit and could not be compared. Review ${omitted.map(spec => link(spec.url, spec.title || spec.id)).join(', ')} separately.</p>`
      : ''
    if (!result.ran) {
      const reasons = {
        'no-bot': 'No review ran. Enable a review bot assigned to this project, then try again.',
        'too-few-specs': 'No review ran. At least two active specs are needed to compare requirements.',
        'context-too-small': 'No review ran. Fewer than two specs fit within the context limit.'
      }
      const message = reasons[result.reason] || 'No review ran. Try again after checking the project’s review bot settings.'
      return result.reason === 'too-few-specs' ? `<p>${esc(message)}</p>` : `<div class="warn"><p>${esc(message)}</p>${omissions}</div>`
    }
    const eligible = count(result.eligible)
    const compared = count(result.compared)
    const rejected = count(result.rejected)
    const failed = count(result.failed)
    const truncated = count(result.truncated)
    const incomplete = compared < eligible || compared < 2 || omitted.length > 0 || rejected > 0 || failed > 0 || truncated > 0
    const findings = Array.isArray(result.findings) ? result.findings : []
    const coverage = compared === eligible && !truncated ? `All ${plural(compared, 'spec')} included.` : `${compared} of ${plural(eligible, 'spec')} included.`
    const summary = findings.length
      ? `${plural(findings.length, 'finding')} in ${findings.length === 1 ? 'a shared discussion' : 'shared discussions'}.`
      : incomplete ? 'No findings recorded.' : 'No supported conflicts or overlaps found.'
    const limitations = [
      rejected ? `${plural(rejected, 'finding')} could not be verified` : '',
      failed ? `${plural(failed, 'finding')} could not be saved` : '',
      truncated ? `${plural(truncated, 'spec')} could not be compared in full` : ''
    ].filter(Boolean)
    const incompleteMessage = limitations.length
      ? `<p>${esc(`Review incomplete: ${limitations.join('; ')}. Run review again to retry these findings.`)}</p>`
      : incomplete && !omitted.length ? '<p>Review incomplete. Run review again before relying on this result.</p>' : ''
    const incompleteWarning = omissions || incompleteMessage ? `<div class="warn">${omissions}${incompleteMessage}</div>` : ''
    const discussions = findings.length ? `<ul class="consistency-findings">${findings.map(finding => `<li>${link(finding.url, finding.title || 'Shared discussion')} · ${finding.resolved ? 'Resolved' : 'Unresolved'}
      <div class="consistency-sources">${(finding.links || []).map(source => link(source.url, source.title)).join(' <span aria-hidden="true">↔</span> ')}</div></li>`).join('')}</ul>
      <p class="legend">Resolve a shared discussion once for both specs.</p>` : ''
    return `<p>${esc(summary)} ${esc(coverage)}</p>${incompleteWarning}${discussions}` +
      warning('Model reviews can miss or misread a conflict. Check the cited requirements and any omissions before relying on this result.')
  }

  function renderConsistency ({ csrf, namespaces = [], namespace, result, error } = {}) {
    const options = namespaces.map(project => `<option value="${esc(project.namespace)}"${project.namespace === namespace ? ' selected' : ''}>${esc(project.namespace)} · ${project.count == null ? 'Count unavailable' : plural(project.count, 'active spec')}</option>`).join('')
    return `<section class="panel consistency-panel" id="consistency-review" aria-labelledby="consistency-heading">
      <h2 id="consistency-heading">Review consistency</h2>
      ${namespaces.length ? `<form method="post" action="/bots/consistency" id="consistency-form">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <label class="project-choice" for="consistency-project">Project <select id="consistency-project" name="ns">${options}</select></label>
        <p>Compare all active specs, from draft through implemented. Findings open shared discussions on both specs. Unresolved discussions block publication and affected checkpoints, even when one spec is a draft.</p>
        <button class="primary" type="submit" id="run-consistency">${result ? 'Run again' : 'Run review'}</button>
      </form>` : '<p>No projects are configured.</p>'}
      <div id="consistency-result" role="status" aria-live="polite" tabindex="-1">${renderConsistencyResult(result, error)}</div>
    </section>`
  }

  const api = { renderConsistency, renderConsistencyResult }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else window.SpecDocConsistency = api
})()
