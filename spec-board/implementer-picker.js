(() => {
  for (const picker of document.querySelectorAll('[data-implementer-picker]')) {
    const search = picker.querySelector('.implementer-search')
    const input = search.querySelector('[name="userQuery"]')
    const add = picker.querySelector('.implementer-add')
    const userId = add.querySelector('[name="userId"]')
    const userLabel = add.querySelector('[name="userLabel"]')
    const button = add.querySelector('button')
    const list = document.createElement('ul')
    list.id = 'implementer-options'
    list.className = 'implementer-options'
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', 'Matching implementers')
    list.hidden = true
    input.parentElement.append(list)
    const status = document.createElement('p')
    status.id = 'implementer-status'
    status.className = 'implementer-status'
    status.setAttribute('role', 'status')
    status.textContent = 'Type at least 2 characters to find an editor account.'
    picker.append(status)
    input.setAttribute('role', 'combobox')
    input.setAttribute('aria-autocomplete', 'list')
    input.setAttribute('aria-controls', list.id)
    input.setAttribute('aria-describedby', status.id)
    input.setAttribute('aria-expanded', 'false')
    search.querySelector('[data-find-users]').hidden = true
    picker.querySelector('.implementer-fallback').hidden = true
    add.hidden = false
    let results = []
    let active = -1
    let serial = 0
    let controller
    let timer

    const label = user => user.login ? '@' + user.login : user.name
    function close () {
      list.hidden = true
      input.setAttribute('aria-expanded', 'false')
      input.removeAttribute('aria-activedescendant')
      active = -1
    }
    function cancel () {
      serial++
      clearTimeout(timer)
      if (controller) controller.abort()
      input.removeAttribute('aria-busy')
    }
    function open () {
      if (!results.length) return
      list.hidden = false
      input.setAttribute('aria-expanded', 'true')
      for (const item of list.children) item.setAttribute('aria-selected', 'false')
    }
    function highlight (index) {
      active = index
      for (const [i, item] of [...list.children].entries()) item.setAttribute('aria-selected', String(i === active))
      input.setAttribute('aria-activedescendant', list.children[active].id)
      list.children[active].scrollIntoView({ block: 'nearest' })
    }
    function choose (user) {
      cancel()
      input.value = label(user)
      userId.value = user.id
      userLabel.value = label(user)
      button.disabled = false
      status.textContent = label(user) + ' selected. Choose Add implementer to save.'
      close()
    }
    async function lookup (sequence) {
      controller = new AbortController()
      input.setAttribute('aria-busy', 'true')
      const params = new URLSearchParams({ ns: search.elements.ns.value, spec: search.elements.spec.value, userQuery: input.value.trim() })
      let message = 'Could not find implementers. Check your connection and try again.'
      try {
        const response = await fetch('/roadmap/users?' + params, { credentials: 'same-origin', signal: controller.signal, headers: { Accept: 'application/json' } })
        const data = await response.json()
        if (sequence !== serial) return
        if (!response.ok) {
          message = data.error || 'Could not find implementers. Try again.'
          throw new Error(message)
        }
        if (!Array.isArray(data.users)) throw new Error('Could not find implementers. Try again.')
        results = data.users
        list.replaceChildren()
        results.forEach((user, index) => {
          const item = document.createElement('li')
          item.id = 'implementer-option-' + index
          item.setAttribute('role', 'option')
          item.setAttribute('aria-selected', 'false')
          item.textContent = label(user) + (user.login && user.name && user.name !== user.login ? ' — ' + user.name : '')
          item.addEventListener('pointerdown', event => event.preventDefault())
          item.addEventListener('click', () => choose(user))
          item.addEventListener('mousemove', () => highlight(index))
          list.append(item)
        })
        status.textContent = results.length
          ? `${results.length} ${results.length === 1 ? 'match' : 'matches'}. Choose an implementer.`
          : 'No matching unassigned users. Implementers need an existing editor account.'
        if (document.activeElement === input) open()
      } catch (error) {
        if (sequence !== serial) return
        status.textContent = message
        close()
      } finally {
        if (sequence === serial) input.removeAttribute('aria-busy')
      }
    }
    function find (delay = 200, composing = false) {
      cancel()
      userId.value = ''
      userLabel.value = ''
      button.disabled = true
      results = []
      list.replaceChildren()
      close()
      if (composing) { status.textContent = 'Finish typing to search.'; return }
      const length = input.value.trim().length
      if (length < 2 || length > 80) {
        status.textContent = length < 2 ? 'Type at least 2 characters to find an editor account.' : 'Use at most 80 characters.'
        return
      }
      status.textContent = 'Searching for implementers…'
      const sequence = serial
      timer = setTimeout(() => lookup(sequence), delay)
    }
    input.addEventListener('input', event => find(200, event.isComposing))
    input.addEventListener('compositionstart', () => find(200, true))
    input.addEventListener('compositionend', () => find())
    input.addEventListener('focus', () => {
      if (userId.value) return
      if (results.length) open()
      else if (input.value.trim().length >= 2) find(0)
    })
    input.addEventListener('blur', close)
    input.addEventListener('keydown', event => {
      if (event.isComposing) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (!results.length) return
        if (list.hidden) open()
        const next = active < 0 ? (event.key === 'ArrowDown' ? 0 : results.length - 1)
          : (active + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length
        highlight(next)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        if (active >= 0 && !list.hidden) choose(results[active])
        else if (!userId.value) find(0)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
        close()
        if (!userId.value && !results.length) status.textContent = 'Search closed. Type to search again.'
      } else if (event.key === 'Tab') close()
    })
    search.addEventListener('submit', event => { event.preventDefault(); find(0) })
    add.addEventListener('submit', event => {
      if (!userId.value) { event.preventDefault(); input.focus() }
    })
    document.addEventListener('click', event => { if (!picker.contains(event.target)) close() })
  }
})()
