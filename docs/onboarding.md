# onboarding a project

a project is a namespace: a github repo that receives approved specs as PRs.
every spec belongs to exactly one, via `namespace: owner/repo` frontmatter or
the board's default. only repos on the operator-controlled allowlist take
part in the PR flow; specs pointing anywhere else get a red namespace chip
and never open PRs.

![board cards carrying their namespace chip](board.png)

## prerequisites

- a github repo to hold the specs. features can live in other repos (see
  `implementation-repos` below).
- the board's service token (`GITHUB_TOKEN`) needs contents read/write and
  pull requests read/write on the repo.
- spec authors have write access on the repo and log in to the editor via
  github. login grants `repo` scope, so the board can open their spec PR
  under their own name.

## steps

1. commit `.specs/roles.yml` to the repo's default branch:

   ```yaml
   approvers: [octocat, hubot]         # GitHub logins allowed to approve
   approvals-required: 2               # quorum; default 1, explicit 0 disables it
   implementation-repos: [owner/app]   # scanned for "implements #N"; default: this repo
   commit-prefix: spec                 # PR/commit type; "" for a bare title
   categories: [api, design, client]   # a matching note tag routes the spec to specs/<category>/
   ```

2. protect the default branch and add a CODEOWNERS rule for `specs/**`.
   board approvals are cooperative workflow; the merge review on the spec PR
   is the enforceable gate. don't skip this and expect the board to be your
   security boundary.

3. add the repo to the board's `NAMESPACES` env (comma-separated) and roll
   the deployment. to make it the default for specs with no namespace, also
   set `DEFAULT_NAMESPACE` on the board and `CMD_SPEC_DEFAULT_NAMESPACE` on
   the editor; the two must match.

4. verify with `curl https://<board-host>/api/namespaces`: `repo`, `push`,
   and `roles` should be `pass` (`protection` stays `unknown` when the token
   can't read branch protection, which is fine), `poller.stale` should be
   `false`.

## roles.yml semantics

- approvers come only from this file, never from the editable note; the note
  records `approved-by` but the roster and quorum are repo-controlled.
- `approvals-required` is clamped to the approver count. malformed values
  fall back to 1; an explicit 0 turns quorum off.
- unresolved comment threads block approval regardless of quorum.
- `categories`: first matching note tag wins; unlisted tags are ignored.
  spec numbering (`NNN`) is per directory, and the category is pinned when
  the PR opens, so later tag edits never re-path an existing PR.
- `implementation-repos`: repos scanned for `implements` commits. omit when
  features land in the spec repo itself.
