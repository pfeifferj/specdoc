# changelog

## unreleased

- Prevent the comment and suggestion tools from inserting review markup in YAML
  headers or before their opening delimiter, which could hide specs from the board.
- Automatically repair existing specs with comments before the YAML header during
  an editor upgrade, preserving comment text, attribution and note permissions.
- Keep affected specs visible on the board before the editor repair runs, while
  continuing to count their open review comments as publication blockers.
