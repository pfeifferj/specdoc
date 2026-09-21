(() => {
  // Menus are mutually exclusive and dismissable. Every other disclosure holds
  // content the reader chose to open, including forms being filled, so nothing
  // closes those but their own summary.
  const MENUS = '.account-menu, .new, .card-actions, .filter-menu'
  const openMenus = () => [...document.querySelectorAll(MENUS)].filter(d => d.open)
  const close = details => { details.open = false }

  // toggle does not bubble, so the listener has to capture.
  document.addEventListener('toggle', event => {
    const menu = event.target
    if (!menu.open || !menu.matches || !menu.matches(MENUS)) return
    for (const other of openMenus()) if (other !== menu && !other.contains(menu)) close(other)
  }, true)

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    const menu = openMenus().pop()
    if (!menu) return
    close(menu)
    const summary = menu.querySelector('summary')
    if (summary) summary.focus()
  })

  document.addEventListener('click', event => {
    if (event.target.closest(MENUS)) return
    for (const menu of openMenus()) close(menu)
  })

  // The return path is only known in the browser, so the link carries it.
  for (const link of document.querySelectorAll('[data-signin]')) {
    link.href = '/login?next=' + encodeURIComponent(location.pathname + location.search)
  }
})()
