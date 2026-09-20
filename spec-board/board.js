(() => {
  const meUrl = document.currentScript.dataset.meUrl
  const key = 'specBoardFilters'
  const state = { chips: [], person: '', implemented: false, layout: 'board', status: '' }
  try { Object.assign(state, JSON.parse(localStorage.getItem(key)) || {}) } catch (e) {}
  state.chips = Array.isArray(state.chips) ? [...new Set(state.chips.filter(c => ['mine', 'review'].includes(c)))] : []
  if (typeof state.person !== 'string') state.person = ''
  state.implemented = state.implemented === true
  state.layout = state.layout === 'list' ? 'list' : 'board'

  const board = document.querySelector('.board')
  const columns = [...board.querySelectorAll('.col')]
  const cards = [...board.querySelectorAll('.card')]
  const chips = [...document.querySelectorAll('.mefilters .chip')]
  const picker = document.querySelector('.person')
  const status = document.querySelector('#status-filter')
  const implemented = document.querySelector('#toggle-impl')
  const active = document.querySelector('.active-filters')
  const personal = document.querySelector('.personal-filters')
  const form = document.querySelector('#board-filters')
  const narrow = matchMedia('(max-width: 760px)')
  const validStatuses = [...status.options].map(o => o.value)
  if (!validStatuses.includes(state.status)) state.status = ''
  if (state.status === 'implemented') state.implemented = true
  let me = ''
  let dirty = false

  function save () {
    try { localStorage.setItem(key, JSON.stringify(state)) } catch (e) {}
  }
  function matches (card, selected) {
    if (!selected.length && !state.person) return true
    return (selected.includes('mine') && card.dataset.author === me) ||
      (selected.includes('review') && card.dataset.review.split(' ').includes(me)) ||
      (state.person && (card.dataset.author === state.person || card.dataset.reviewers.split(' ').includes(state.person)))
  }
  function token (label, remove) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'filter-token'
    button.setAttribute('aria-label', 'Remove filter: ' + label)
    const text = document.createElement('span')
    text.textContent = label
    const cross = document.createElement('span')
    cross.textContent = '×'
    cross.setAttribute('aria-hidden', 'true')
    button.append(text, cross)
    button.addEventListener('click', () => {
      remove()
      save()
      apply()
      document.querySelector('#result-count').focus()
    })
    personal.append(button)
  }
  function apply () {
    if (state.person && ![...picker.options].some(o => o.value === state.person)) {
      state.person = ''
      save()
    }
    const selected = me ? state.chips : []
    const layout = narrow.matches ? 'list' : state.layout
    board.dataset.layout = layout
    document.querySelectorAll('[data-layout-choice]').forEach(button => {
      button.setAttribute('aria-pressed', button.dataset.layoutChoice === layout)
    })
    chips.forEach(chip => {
      const on = selected.includes(chip.dataset.filter)
      chip.classList.toggle('on', on)
      chip.setAttribute('aria-pressed', on)
    })
    picker.value = state.person
    status.value = state.status
    implemented.checked = state.implemented
    cards.forEach(card => { card.hidden = !matches(card, selected) })
    let visible = 0
    columns.forEach(column => {
      column.hidden = (column.dataset.status === 'implemented' && !state.implemented) ||
        (!!state.status && column.dataset.status !== state.status)
      const items = [...column.querySelectorAll('.card')]
      const count = items.filter(card => !card.hidden).length
      column.querySelector('.count').textContent = count
      const empty = column.querySelector('.empty')
      empty.hidden = count > 0
      empty.textContent = items.length ? 'No matches in this stage.' : 'No specs in this stage.'
      if (!column.hidden) visible += count
    })
    personal.replaceChildren()
    if (state.person) token('Author or reviewer: ' + state.person, () => { state.person = '' })
    selected.forEach(value => token(value === 'mine' ? 'My specs' : 'To review', () => {
      state.chips = state.chips.filter(chip => chip !== value)
    }))
    if (state.status) token('Stage: ' + status.selectedOptions[0].textContent, () => { state.status = '' })
    active.hidden = !active.querySelector('[data-url-filter]') && !personal.childElementCount
    document.querySelector('#result-count').textContent = visible + (visible === 1 ? ' spec' : ' specs') + (active.hidden ? '' : visible === 1 ? ' matches your filters' : ' match your filters')
    document.querySelector('#no-matches').hidden = visible > 0 || (!cards.length && active.hidden)
    document.querySelector('#no-specs').hidden = cards.length > 0 || !active.hidden
    board.hidden = !visible
  }

  picker.addEventListener('change', () => { state.person = picker.value; save(); apply() })
  status.addEventListener('change', () => {
    state.status = status.value
    if (state.status === 'implemented') state.implemented = true
    save()
    apply()
  })
  implemented.addEventListener('change', () => {
    state.implemented = implemented.checked
    if (!state.implemented && state.status === 'implemented') state.status = ''
    save()
    apply()
  })
  chips.forEach(chip => chip.addEventListener('click', () => {
    const value = chip.dataset.filter
    state.chips = state.chips.includes(value) ? state.chips.filter(c => c !== value) : [...state.chips, value]
    save()
    apply()
  }))
  document.querySelectorAll('[data-layout-choice]').forEach(button => button.addEventListener('click', () => {
    state.layout = button.dataset.layoutChoice
    save()
    apply()
  }))
  document.querySelectorAll('[data-clear-filters]').forEach(link => link.addEventListener('click', event => {
    state.chips = []
    state.person = ''
    state.status = ''
    save()
    if (!active.querySelector('[data-url-filter]')) {
      event.preventDefault()
      apply()
      document.querySelector('#result-count').focus()
    }
  }))
  form.addEventListener('input', () => { dirty = true })
  form.addEventListener('change', event => { if (event.target.name) dirty = true })
  narrow.addEventListener('change', apply)
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    const disclosure = document.activeElement.closest('details[open]')
    if (disclosure) {
      disclosure.open = false
      disclosure.querySelector('summary').focus()
    }
  })
  document.querySelector('#refresh-board').addEventListener('click', () => location.reload())
  apply()
  document.querySelectorAll('[data-enhanced]').forEach(el => { el.hidden = false })
  fetch(meUrl, { credentials: 'include' })
    .then(response => response.json())
    .then(identity => {
      if (!identity || identity.status !== 'ok' || !identity.username) return
      me = String(identity.username).toLowerCase()
      document.querySelector('.mefilters').hidden = false
      apply()
    })
    .catch(() => {})

  setInterval(() => {
    const focused = document.activeElement
    if (document.hidden || dirty || document.querySelector('details[open]') ||
        (focused && focused !== document.body && focused !== document.documentElement) ||
        window.getSelection().toString()) return
    location.reload()
  }, 30000)
})()
