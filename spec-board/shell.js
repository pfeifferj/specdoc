(() => {
  // The flag a stylesheet rule tests to style a control only where this script
  // runs. The script is deferred, so the flag arrives after the document is
  // parsed and a rule on it cannot be relied on to beat the first paint.
  document.documentElement.classList.add('js')

  // Looking at a related thing must not destroy the one being filled. A page
  // can hold one guarded form per row (a milestone each, on planning), so a
  // save clears only the form that was saved and a sibling left half filled
  // still warns. The browser owns the wording; no custom string is set,
  // because none is shown.
  const dirty = new Set()
  const record = form => form.closest('details, article, section') || form
  for (const form of document.querySelectorAll('form.edit, form[data-guard]')) {
    const mark = () => dirty.add(form)
    form.addEventListener('input', mark)
    form.addEventListener('change', mark)
  }
  // A write is a decision, not a loss: a delete pressed beside a half-filled
  // edit form discards those edits by design, so a write clears the guard on
  // every form of the record it writes, and only a form outside that record
  // still warns. A GET stays guarded, which is where the warning is wanted.
  document.addEventListener('submit', event => {
    const form = event.target
    if (!form.method || form.method.toLowerCase() !== 'post') return
    for (const marked of dirty) if (marked === form || record(marked) === record(form)) dirty.delete(marked)
  }, true)
  addEventListener('beforeunload', event => { if (dirty.size) event.preventDefault() })

  // Menus are mutually exclusive and dismissable. Every other disclosure holds
  // content the reader chose to open, including forms being filled, so nothing
  // closes those but their own summary.
  const MENUS = '.account-menu, .new, .card-actions, .filter-menu'
  const openMenus = () => [...document.querySelectorAll(MENUS)].filter(d => d.open)
  const summaryOf = menu => menu.querySelector(':scope > summary')
  // What the page rendered for a control: what an abandoned menu puts back, and
  // what "the reader changed this" is measured against.
  const rendered = control => control.localName === 'select'
    ? ([...control.options].find(o => o.defaultSelected) || control.options[0] || { value: '' }).value
    : control.defaultValue
  // Measured over the controls the menu contains, not over a form it contains:
  // the board's Filters panel is a menu inside the page's own filter form, so
  // there the form holds the menu rather than the other way round. A control
  // with no name is a client-side filter the page has already applied, so it
  // carries no pending change and keeps the value the page gave it.
  const fields = menu => [...menu.querySelectorAll('input[name], select[name], textarea[name]')].filter(el => el.type !== 'hidden')
  const staged = menu => fields(menu).filter(el => el.type === 'checkbox' || el.type === 'radio'
    ? el.checked !== el.defaultChecked
    : el.value !== rendered(el))
  const holdsWrite = menu => staged(menu).length > 0
  // A menu is dismissable and the write inside it is not, so a dismissal
  // abandons the write instead of carrying it off silently: each control goes
  // back to what the page rendered, and a summary closed over a changed select
  // carries the mark until the menu is opened again.
  const abandon = menu => {
    const held = staged(menu)
    const summary = summaryOf(menu)
    if (summary && held.some(el => el.localName === 'select')) summary.dataset.unsaved = ''
    for (const el of held) {
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = el.defaultChecked
      else el.value = rendered(el)
    }
    for (const form of menu.querySelectorAll('form')) dirty.delete(form)
  }
  const close = menu => { abandon(menu); menu.open = false }

  // toggle does not bubble, so the listener has to capture.
  document.addEventListener('toggle', event => {
    const menu = event.target
    if (!menu.matches || !menu.matches(MENUS)) return
    if (!menu.open) return abandon(menu)
    const summary = summaryOf(menu)
    if (summary) delete summary.dataset.unsaved
    for (const other of openMenus()) if (other !== menu && !other.contains(menu)) close(other)
  }, true)

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    const menu = openMenus().pop()
    if (!menu) return
    close(menu)
    const summary = summaryOf(menu)
    if (summary) summary.focus()
  })

  document.addEventListener('click', event => {
    if (event.target.closest(MENUS)) return
    // A click elsewhere is no answer to a write the reader has started, so a
    // menu holding one stays open. Its summary and Escape still dismiss it.
    for (const menu of openMenus()) if (!holdsWrite(menu)) close(menu)
  })

  // A null relatedTarget is focus leaving the document for the browser chrome,
  // where the menu is still on screen and still being read.
  document.addEventListener('focusout', event => {
    const menu = event.target.closest && event.target.closest(MENUS)
    if (!menu || !menu.open || holdsWrite(menu)) return
    if (!event.relatedTarget || menu.contains(event.relatedTarget)) return
    close(menu)
  })

  // The return path is only known in the browser, so the link carries it.
  for (const link of document.querySelectorAll('[data-signin]')) {
    link.href = '/login?next=' + encodeURIComponent(location.pathname + location.search)
  }

  // A read-only filter applies as it is set, as long as one change is one
  // criterion: a row where the reader has two in mind would cost a load each.
  // So a form with a single named select submits on a change and drops its
  // commit button, and a form with more than one keeps the button as its named
  // commit. The method check keeps a write from ever auto-submitting. An
  // unnamed select is a client-side filter the page has already applied.
  for (const form of document.querySelectorAll('form[data-autosubmit]')) {
    if (form.method.toLowerCase() !== 'get') continue
    const selects = [...form.querySelectorAll('select[name]')]
    const button = form.querySelector('[data-apply]')
    const single = selects.length === 1
    // What each select shows for the address the page was loaded with.
    const carried = new Map(selects.map(select => [select, select.value]))
    let stepping = false
    let pending = null
    let set = null
    const commit = select => {
      pending = null
      set = select
      form.requestSubmit()
      // A submit the guard cancels leaves the page standing, and a select left
      // describing a filter the page never applied cannot be applied again: the
      // same option fires no change. The entry list is built inside
      // requestSubmit, so putting the value back cannot alter a submit that goes.
      if (dirty.size && carried.has(select)) select.value = carried.get(select)
    }
    // The typed filter narrows the specs already on screen. Committing the
    // selects must not turn it into a full-text query over every spec, and must
    // not drop the q the page was loaded with, so the box is client state for
    // this submit and the address's own q rides as a hidden field. Enter in the
    // box and the search button carry that button as the submitter, and search.
    // The commit reloads, and client state does not survive a load, so what the
    // reader typed rides in the session-storage key board.js reads once on load,
    // the carrier its own Refresh already uses.
    form.addEventListener('submit', event => {
      if (event.submitter && event.submitter !== button) return
      const typed = form.querySelector('input[type="search"][name]')
      const carry = typed ? typed.value.trim() : ''
      if (carry) {
        try { sessionStorage.setItem('specBoardQuery', carry) } catch (e) {}
      }
      const query = typed && new URLSearchParams(location.search).get(typed.name)
      const undo = []
      if (query) {
        const held = form.appendChild(document.createElement('input'))
        held.type = 'hidden'
        held.name = typed.name
        held.value = query
        undo.push(() => held.remove())
      }
      if (set) {
        const mark = form.querySelector('input[name="focus"]') || form.appendChild(document.createElement('input'))
        mark.type = 'hidden'
        mark.name = 'focus'
        mark.value = set.name
      }
      // An empty control would otherwise land in the address as a bare key.
      const off = [...form.elements].filter(el => el.name && !el.disabled && (el === typed || el.value === ''))
      const active = document.activeElement
      for (const el of off) el.disabled = true
      // The entry list is built as this listener returns, so the controls can be
      // live again on the next task, and the page whole again after a submit
      // the unsaved-edit guard stops.
      setTimeout(() => {
        for (const el of off) el.disabled = false
        for (const step of undo) step()
        if (off.includes(active)) active.focus()
      })
    })
    // A closed select walks its options on the arrow keys and fires change on
    // every step, so submitting each change would carry a keyboard user off the
    // page at the first option they pass. A step changes the value inside the
    // key's own task; an option taken from the open list, or from a pointer,
    // arrives in a later one. So a change that lands in the key's task waits for
    // the commit: Enter, or focus leaving the select.
    form.addEventListener('keydown', event => {
      if (!event.target.matches('select[name]')) return
      if (event.key === 'Enter') {
        event.preventDefault()
        commit(event.target)
        return
      }
      if (!single) return
      stepping = true
      setTimeout(() => { stepping = false })
    })
    form.addEventListener('change', event => {
      if (!event.target.matches('select[name]')) return
      set = event.target
      if (!single) return
      if (stepping) pending = event.target
      else commit(event.target)
    })
    form.addEventListener('focusout', event => { if (pending === event.target) commit(event.target) })
    // data-apply marks a commit the script has taken over, which the stylesheet
    // hides on the js flag. A row that still needs its own commit keeps it, and
    // the mark goes.
    if (button) {
      if (single) button.hidden = true
      else button.removeAttribute('data-apply')
    }
  }

  // Focus follows the control that reloaded the page, into its panel when it
  // sits in one. The address drops the parameter that carried it, so a link
  // shared from here moves nobody's focus.
  const focused = new URLSearchParams(location.search).get('focus')
  if (focused && /^[\w-]+$/.test(focused)) {
    const rest = new URLSearchParams(location.search)
    rest.delete('focus')
    const search = rest.toString()
    // replaceState throws on a file:// document, which is how the render harness loads the page.
    try { history.replaceState(null, '', location.pathname + (search ? '?' + search : '') + location.hash) } catch (e) {}
    const control = document.querySelector(`form[data-autosubmit] [name="${focused}"]`)
    for (let node = control; node; node = node.parentElement) if (node.localName === 'details') node.open = true
    if (control) control.focus()
  }
})()
