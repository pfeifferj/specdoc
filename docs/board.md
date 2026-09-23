# reading the board

the board at `/` lists every tracked spec as a card in the lane its status
puts it in. what the statuses mean and how a spec moves between them is in the
[spec lifecycle](spec-lifecycle.md). this page covers reading the page itself.

## lanes and cards

five lanes: Draft, Ready for review, In review, Approved, Implemented. the
Implemented lane stays closed until **Show implemented** in **Filters** is
ticked, so the board shows work in flight by default. **Board** and **List**
beside the heading switch the layout.

a card puts its review state below the title: an approval count whose tooltip
names the reviewers it is waiting on, one **unresolved** count for open comment
threads and pending suggestions (the tooltip breaks it down), a **Stale**
marker after `STALE_DAYS` without a change, and a "changed since N approvals"
link to the [comparison](spec-lifecycle.md#what-changed).

the line below groups the project and area, spec and revision pull requests,
milestone, implementers, author and last change time. possible conflicts with
other specs reported by a [review bot](spec-lifecycle.md#review) sit here too;
they are advisory and never block approval. actions live in the card menu,
including the spec's [planning panel](roadmap.md) and, for a project approver
or board admin, setting its milestone without leaving the board.

## finding specs

the filter box narrows the cards already on the page as you type; enter asks
the board for the full text of every spec instead. **Filters** holds the rest:
project, milestone and implementer reload the board, while stage and
author-or-reviewer filter the page you have. **My specs** and **To review**
need a sign-in. each filter in force shows as a token in the toolbar, and
clicking it off removes it.

the project filter includes only specs assigned to that project, including
its top-level specs. choose **All projects** to see specs from other projects.

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

- when cards have changed, a **3 changed, reload** button appears beside the
  spec count. a screen reader is told the count once per change rather than
  every tick.
- nothing on the page moves until you press that button.
- after that reload, the cards the count stood for are marked "Updated since
  you loaded the board". the mark lasts one load; the next reload marks
  whatever has changed by then.
- a counted change the reload cannot show says so in the summary row: cards
  hidden by a filter, cards in the closed Implemented lane (with **Show
  implemented** named as the way to see them), and specs that have left the
  board. the count covers those too, so it says the board is behind rather than
  promising a visible difference.

the ids of those cards ride through the reload in the tab's session storage,
along with any text typed into the filter box, so using the reload button loses
neither. both are gone when the tab closes.
