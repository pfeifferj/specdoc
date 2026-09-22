(() => {
  const meUrl = document.currentScript.dataset.meUrl
  // The board's own session, so the review chip still works when the editor is
  // unreachable. Only the editor knows the author login, so "mine" needs /me.
  const boardLogin = (document.currentScript.dataset.login || '').toLowerCase()
  const key = 'specBoardFilters'
  const params = new URLSearchParams(location.search)
  const state = { chips: [], person: '', implemented: false, layout: 'board', status: '' }
  try { Object.assign(state, JSON.parse(localStorage.getItem(key)) || {}) } catch (e) {}
  // A key in the query string wins over the stored value, so a shared link shows the sender's board.
  if (params.has('chips')) state.chips = params.get('chips').split(',')
  if (params.has('person')) state.person = params.get('person')
  if (params.has('implemented')) state.implemented = params.get('implemented') === '1'
  if (params.has('layout')) state.layout = params.get('layout')
  if (params.has('stage')) state.status = params.get('stage')
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
  const searchBox = form.querySelector('input[name=q]')
  const summary = form.querySelector('.filter-menu > summary')
  const filterCount = document.createElement('span')
  const hint = document.createElement('p')
  const chipHint = document.createElement('p')
  const noMatches = document.querySelector('#no-matches')
  const noMatchTitle = noMatches.querySelector('#no-matches-title')
  const defaultNoMatch = noMatchTitle.textContent
  const fullText = document.createElement('button')
  const haystack = new Map(cards.map(card => [card, [card.querySelector('.title').textContent,
    card.dataset.author, card.querySelector('.ns') ? card.querySelector('.ns').textContent : ''].join(' ').toLowerCase()]))
  let me = ''
  let query = ''
  let painted = false
  // Set once the marks from the last Refresh are on the page. apply() calls it
  // because a filter change hides or reveals a marked card.
  let showMarks = () => {}
  // The typed filter never reaches the address, so Refresh hands it to the
  // next load through sessionStorage. The key is read once and dropped, so a
  // fresh tab starts empty.
  try {
    const typed = sessionStorage.getItem('specBoardQuery')
    sessionStorage.removeItem('specBoardQuery')
    if (typed) {
      searchBox.value = typed
      query = typed.trim().toLowerCase()
    }
  } catch (e) {}

  filterCount.className = 'filter-count'
  filterCount.hidden = true
  summary.insertBefore(filterCount, summary.lastElementChild)
  hint.className = 'search-hint'
  hint.id = 'search-hint'
  hint.textContent = 'Press Enter to search the full text of every spec.'
  form.querySelector('.search').after(hint)
  searchBox.setAttribute('aria-describedby', hint.id)
  chipHint.className = 'meta'
  chipHint.hidden = true
  document.querySelector('.mefilters').after(chipHint)
  fullText.type = 'button'
  fullText.className = 'button primary'
  fullText.textContent = 'Search the full text'
  fullText.hidden = true
  fullText.addEventListener('click', () => form.requestSubmit())
  noMatches.append(fullText)
  // The form's own GET writes only its server fields, so the client filters
  // ride along as hidden inputs.
  const carried = {}
  for (const name of ['stage', 'person', 'chips', 'layout', 'implemented']) {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    carried[name] = input
    form.append(input)
  }

  const usable = chip => chip === 'review' ? !!(me || boardLogin) : !!me
  function save () {
    try { localStorage.setItem(key, JSON.stringify(state)) } catch (e) {}
    const next = new URLSearchParams(location.search)
    const put = (name, value) => { if (value) next.set(name, value); else next.delete(name) }
    put('stage', state.status)
    put('person', state.person)
    put('chips', state.chips.join(','))
    put('layout', state.layout === 'list' ? 'list' : '')
    put('implemented', state.implemented ? '1' : '')
    // The save notice is a one-off: it is on the page already, and keeping its
    // keys would replay it on every reload and hand it to anyone the address
    // reaches. They are dropped once the browser has used them to scroll.
    if (painted) { next.delete('saved'); next.delete('spec') }
    const search = next.toString()
    // The hash is the card the reader came back to; dropping it would send the
    // next load to the top of the board.
    // replaceState throws on a file:// document, which is how the render harness loads the page.
    try { history.replaceState(null, '', location.pathname + (search ? '?' + search : '') + location.hash) } catch (e) {}
  }
  function matches (card, selected) {
    if (query && !haystack.get(card).includes(query)) return false
    if (!selected.length && !state.person) return true
    return (selected.includes('mine') && card.dataset.author === me) ||
      (selected.includes('review') && card.dataset.review.split(' ').includes(me || boardLogin)) ||
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
    carried.stage.value = state.status
    carried.person.value = state.person
    carried.chips.value = state.chips.join(',')
    carried.layout.value = state.layout === 'list' ? 'list' : ''
    carried.implemented.value = state.implemented ? '1' : ''
    const selected = state.chips.filter(usable)
    const layout = narrow.matches ? 'list' : state.layout
    board.dataset.layout = layout
    document.querySelectorAll('[data-layout-choice]').forEach(button => {
      button.setAttribute('aria-pressed', button.dataset.layoutChoice === layout)
    })
    chips.forEach(chip => {
      const on = selected.includes(chip.dataset.filter)
      chip.classList.toggle('on', on)
      chip.setAttribute('aria-pressed', on)
      chip.disabled = !usable(chip.dataset.filter)
    })
    const refused = chips.filter(chip => chip.disabled).map(chip => chip.textContent)
    chipHint.textContent = refused.length ? 'Sign in to the editor to use ' + refused.join(' and ') + '.' : ''
    chipHint.hidden = !refused.length
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
    // Counted off the tokens themselves, so the badge and the row beneath it
    // cannot disagree, and the typed search counts like any other filter.
    const count = active.querySelectorAll('[data-url-filter]').length + personal.childElementCount
    filterCount.textContent = count
    filterCount.hidden = !count
    active.hidden = !active.querySelector('[data-url-filter]') && !personal.childElementCount
    const filtered = !active.hidden || !!query
    document.querySelector('#result-count').textContent = visible + (visible === 1 ? ' spec' : ' specs') + (!filtered ? '' : visible === 1 ? ' matches your filters' : ' match your filters')
    noMatchTitle.textContent = query ? `Nothing here matches "${searchBox.value.trim()}" in a title, author or project` : defaultNoMatch
    fullText.hidden = !query
    noMatches.hidden = visible > 0 || (!cards.length && !filtered)
    document.querySelector('#no-specs').hidden = cards.length > 0 || !active.hidden
    board.hidden = !visible
    showMarks()
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
    query = ''
    searchBox.value = ''
    save()
    if (!active.querySelector('[data-url-filter]')) {
      event.preventDefault()
      apply()
      document.querySelector('#result-count').focus()
    }
  }))
  searchBox.addEventListener('input', () => { query = searchBox.value.trim().toLowerCase(); apply() })
  searchBox.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !query) return
    searchBox.value = ''
    query = ''
    apply()
  })
  // An empty control would otherwise land in the address as a bare key.
  form.addEventListener('submit', () => {
    form.querySelectorAll('[name]').forEach(control => { if (control.value === '') control.disabled = true })
  })
  document.addEventListener('keydown', event => {
    const target = event.target
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || !target ||
        target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
    event.preventDefault()
    searchBox.focus()
    searchBox.select()
  })
  narrow.addEventListener('change', apply)
  save()
  apply()
  // The notice keys are wanted for the browser's own jump to #spec-<id>, and
  // only then.
  requestAnimationFrame(() => { painted = true; save() })
  document.querySelectorAll('[data-enhanced]').forEach(el => { el.hidden = false })
  fetch(meUrl, { credentials: 'include' })
    .then(response => response.json())
    .then(identity => {
      if (!identity || identity.status !== 'ok' || !identity.username) return
      me = String(identity.username).toLowerCase()
      apply()
    })
    .catch(() => {})
    .finally(() => {
      if (state.chips.every(usable)) return
      state.chips = state.chips.filter(usable)
      save()
      apply()
    })

  const changedKey = 'specBoardChanged'
  const cardKey = card => card.dataset.id || card.querySelector('.title').textContent
  // Keyed by card, so a re-sort on its own is not a change. The value covers
  // what the reader watches on a card: its lane, when it last changed, its tags,
  // its review state (approvals, waiting on, open comments, suggestions, stale)
  // and its links. The lane carries the moves the note's own text never shows,
  // such as quorum reached or an implements commit found.
  const signature = doc => new Map([...doc.querySelectorAll('.board .card')].map(card => {
    const part = selector => {
      const el = card.querySelector(selector)
      if (!el) return ''
      // The stale badge counts days from now, so its text turns over once a day
      // with no edit to the note. Compare the badge, not its age.
      return el.textContent.replace(/\s+/g, ' ').trim().replace(/no change for (over )?\d+ days/, 'stale')
    }
    const time = card.querySelector('time')
    const lane = card.closest('.col')
    return [cardKey(card),
      [lane ? lane.dataset.status : '', time ? time.getAttribute('datetime') : '',
        part('.card-tags'), part('.review-state'), part('.card-links')].join('@')]
  }))

  // What the last check found, handed to the next load so the board that
  // arrives marks the cards the count stood for.
  let changedIds = []
  let checkedAt = Date.now()
  const ago = ms => {
    if (ms < 45000) return 'just now'
    const minutes = Math.round(ms / 60000)
    if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago')
    const hours = Math.round(minutes / 60)
    return hours + (hours === 1 ? ' hour ago' : ' hours ago')
  }
  const checked = () => 'Checked for changes ' + ago(Date.now() - checkedAt) + ', and every 30 seconds'
  const options = document.querySelector('.display-options')
  const refresh = document.querySelector('#refresh-board')
  const refreshLabel = [...refresh.childNodes].find(node => node.nodeType === 3 && node.nodeValue.trim())
  const clock = document.createElement('span')
  const news = document.createElement('span')
  const marks = document.createElement('span')
  const voice = document.createElement('span')
  const keptHere = document.createElement('span')
  clock.className = 'meta check-age'
  clock.textContent = checked()
  // The count goes on the control it asks for, so reading it and acting on it
  // are one target. The sentence is left for the screen reader, once per change.
  news.className = 'sr-only'
  news.setAttribute('role', 'status')
  // The sentence is painted with the row, and hidden while there is none,
  // because an empty span still takes a gap. A hidden live region is out of
  // the accessibility tree, so the spoken copy is a clipped region that is on
  // the page from the start and costs no space; aria-hidden keeps the pair
  // from reading twice.
  marks.className = 'meta'
  marks.hidden = true
  marks.setAttribute('aria-hidden', 'true')
  voice.className = 'sr-only'
  voice.setAttribute('role', 'status')
  keptHere.className = 'meta'
  // Stage and person sit in the Filters panel, which is closed unless the
  // reader opens it, so the claim for all five is made in the row that is
  // always on screen. The layout switch is hidden under 760px (board.css),
  // where naming it points at nothing.
  const keptSentence = () => 'Stage, person, ' + (narrow.matches ? '' : 'layout, ') + 'Show implemented and the chips are kept in this browser.'
  keptHere.textContent = keptSentence()
  narrow.addEventListener('change', () => { keptHere.textContent = keptSentence() })
  options.querySelector('label').after(keptHere)
  refresh.before(clock)
  refresh.before(news)
  refresh.before(marks)
  refresh.before(voice)
  refresh.addEventListener('click', () => {
    // Only carry what the reader typed here; a q= search is already in the address.
    try {
      if (query) sessionStorage.setItem('specBoardQuery', searchBox.value)
      if (changedIds.length) sessionStorage.setItem(changedKey, changedIds.join('\n'))
    } catch (e) {}
    location.reload()
  })
  // Read once and dropped, so a mark lasts one load: the next Refresh writes
  // whatever the check found by then, which is nothing when nothing moved.
  let marked = new Set()
  try {
    const stored = sessionStorage.getItem(changedKey)
    sessionStorage.removeItem(changedKey)
    if (stored) marked = new Set(stored.split('\n'))
  } catch (e) {}
  if (marked.size) {
    const found = cards.filter(card => marked.has(cardKey(card)))
    for (const card of found) {
      card.classList.add('updated')
      const line = document.createElement('p')
      line.className = 'update-note'
      line.textContent = 'Updated since you loaded the board'
      card.querySelector('h3').after(line)
    }
    const gone = marked.size - found.length
    // The spoken copy arrives a frame after the load: a live region announces a
    // change made to it, not the text it already holds when the page arrives.
    // Saying the same sentence again would repeat it on every filter change.
    let saying = ''
    const say = text => {
      if (text === saying) return
      saying = text
      marks.textContent = text
      marks.hidden = !text
      const speak = () => requestAnimationFrame(() => { if (voice.textContent !== saying) voice.textContent = saying })
      if (document.readyState === 'complete') speak()
      else addEventListener('load', speak, { once: true })
    }
    // The count the reader pressed stood for these cards, and a mark nobody can
    // see pays none of it: a spec that reached Implemented sits in a lane the
    // board keeps closed, a filtered card is hidden, and a deleted one has no
    // card at all.
    showMarks = () => {
      const lane = card => card.closest('.col')
      const hidden = found.filter(card => card.hidden || (lane(card) && lane(card).hidden))
      // Ticking the box is the whole act only when nothing else is in the way:
      // a stage filter closes that lane as well, and a card the person, chip or
      // search filters hide stays hidden either way.
      const tick = hidden.length && !state.implemented && !state.status &&
        hidden.every(card => !card.hidden && lane(card) && lane(card).dataset.status === 'implemented')
      const parts = []
      if (hidden.length) parts.push(hidden.length + (hidden.length === 1 ? ' is ' : ' are ') + (tick ? 'in the Implemented lane' : 'hidden by a filter'))
      if (gone) parts.push(gone + (gone === 1 ? ' is ' : ' are ') + 'no longer on the board')
      const said = parts.length
        ? 'Of the changes you refreshed for, ' + parts.join(', ') + '.' +
          (tick ? ' Tick Show implemented to see ' + (hidden.length === 1 ? 'it.' : 'them.') : '')
        : ''
      say(said)
    }
    showMarks()
  }
  setInterval(async () => {
    clock.textContent = checked()
    if (document.hidden) return
    try {
      const response = await fetch(location.href, { credentials: 'same-origin' })
      if (!response.ok) return
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html')
      const before = signature(document)
      const now = signature(doc)
      const ids = []
      for (const [id, entry] of now) if (before.get(id) !== entry) ids.push(id)
      for (const id of before.keys()) if (!now.has(id)) ids.push(id)
      changedIds = ids
      checkedAt = Date.now()
      clock.textContent = checked()
      if (refreshLabel) refreshLabel.nodeValue = ids.length ? `Refresh · ${ids.length} changed` : 'Refresh'
      refresh.classList.toggle('accent', ids.length > 0)
      // A card a filter hides, one in a lane the reader keeps closed and one
      // that has left the board are all counted, so the sentence says the board
      // is behind rather than promising a visible difference. The load after
      // Refresh accounts for whichever of them carries no mark on screen.
      const next = ids.length ? `${ids.length} ${ids.length === 1 ? 'spec has' : 'specs have'} changed. Refresh to bring the board up to date.` : ''
      // A live region announces on any childList change, so writing the same
      // sentence again repeats it to a screen reader every tick.
      if (news.textContent !== next) news.textContent = next
    } catch (e) {}
  }, 30000)
})()
