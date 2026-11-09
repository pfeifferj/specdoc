(() => {
  const form = document.getElementById('consistency-form')
  if (!form || !window.SpecDocConsistency || !window.fetch) return
  const panel = document.getElementById('consistency-review')
  const result = document.getElementById('consistency-result')
  const project = document.getElementById('consistency-project')
  const button = document.getElementById('run-consistency')
  let running = false

  project.addEventListener('change', () => {
    result.replaceChildren()
    button.textContent = 'Run review'
    const url = new URL(location.href)
    url.searchParams.set('ns', project.value)
    history.replaceState(null, '', url)
  })

  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (running) return
    running = true
    const body = new URLSearchParams(new FormData(form))
    project.disabled = true
    button.disabled = true
    button.textContent = 'Reviewing…'
    panel.setAttribute('aria-busy', 'true')
    result.textContent = 'Comparing active specs… Findings will appear here when the review finishes.'
    try {
      const response = await fetch(form.action, {
        method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/json' }, body
      })
      const data = await response.json()
      if (!response.ok) {
        result.innerHTML = window.SpecDocConsistency.renderConsistencyResult(data, data.error || 'The review could not run. Try again.')
      } else {
        result.innerHTML = window.SpecDocConsistency.renderConsistencyResult(data)
      }
    } catch {
      result.innerHTML = window.SpecDocConsistency.renderConsistencyResult(null, 'The review result could not be loaded. Reload this page to check whether it finished before running it again.')
    } finally {
      running = false
      project.disabled = false
      button.disabled = false
      button.textContent = 'Run again'
      panel.removeAttribute('aria-busy')
      if (document.activeElement === button || document.activeElement === document.body || result.contains(document.activeElement)) result.focus({ preventScroll: true })
    }
  })
})()
