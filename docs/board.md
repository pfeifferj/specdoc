# reading the board

the board at `/` lists every tracked spec as a card in the lane its status
puts it in. what the statuses mean and how a spec moves between them is in the
[spec lifecycle](spec-lifecycle.md). this page covers reading the page itself.

## lanes and cards

five lanes: Draft, Ready for review, In review, Approved, Implemented. the
Implemented lane stays closed until **Show implemented** is ticked, so the board
shows work in flight by default. **Board** and **List** beside the heading
switch the layout.

a card carries the spec title, its project and area, the approval count with
who it is waiting on, open comment threads and pending suggestions, a stale
marker after `STALE_DAYS` without a change, and a "changed since N approvals"
link to the [comparison](spec-lifecycle.md#what-changed). below that sit its
spec and revision pull requests, its milestone and its implementers. the card
menu links the spec's [planning panel](roadmap.md), and for a project approver
or board admin it also sets the milestone without leaving the board.

## finding specs

the filter box narrows the cards already on the page as you type; enter asks
the board for the full text of every spec instead. **Filters** holds the rest:
project, milestone and implementer reload the board, while stage and
author-or-reviewer filter the page you have. **My specs** and **To review**
need a sign-in. each filter in force shows as a token under the row, and
clicking it off removes it.

stage, the person filter, the layout, the chips and **Show implemented** are
kept in your browser and written into the page address, so a link you copy
shows the board as you left it. the board's `/privacy` page lists what that
storage holds.

## staying current

the board does not reload itself. every 30 seconds it fetches the same page in
the background and compares the cards to the ones on screen: the lane, the last
change time, the tags, the review state and the links, keyed per card, so a
re-sort on its own counts as nothing. a check while the tab is in the
background is skipped, and a check that fails changes nothing and waits for the
next one.

what a check finds:

- the count goes on the button that acts on it, which reads **Refresh · 3
  changed**. beside it, the summary row says when the last check ran. a screen
  reader is told the count once per change rather than every tick.
- nothing on the page moves until you press **Refresh**.
- after that reload, the cards the count stood for are marked "New since you
  loaded the board". the mark lasts one load; the next **Refresh** marks
  whatever has changed by then.
- a counted change the reload cannot show says so in the summary row: cards
  hidden by a filter, cards in the closed Implemented lane (with **Show
  implemented** named as the way to see them), and specs that have left the
  board. the count covers those too, so it says the board is behind rather than
  promising a visible difference.

the ids of those cards ride through the reload in the tab's session storage,
along with any text typed into the filter box, so pressing **Refresh** loses
neither. both are gone when the tab closes.
