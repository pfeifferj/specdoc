# changelog

## unreleased

- Keep comment and suggestion cards above the editor in split view, with their
  controls reachable while scrolling or resizing the preview.
- Include the frontmatter repair helper in the board image and build that image
  in CI so missing runtime files fail before deployment.
- Prevent the comment and suggestion tools from inserting review markup in YAML
  headers or before their opening delimiter, which could hide specs from the board.
- Automatically repair existing specs with comments before the YAML header during
  an editor upgrade, preserving comment text, attribution and note permissions.
- Keep affected specs visible on the board before the editor repair runs, while
  continuing to count their open review comments as publication blockers.
