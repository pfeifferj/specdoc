#!/usr/bin/env bash
# SpecDoc build-time overlay. Runs between COPY and yarn build so the .work
# source tree stays upstream-clean and the rebrand re-applies on every image
# build (no per-file fork edits to conflict on rebase).
set -euo pipefail

# 1. Brand the display strings. Only the CamelCase "HedgeDoc" is a brand
#    string; the lowercase @hedgedoc/ package names and hedgedoc db/cookie
#    identifiers are never matched, so they stay functional.
brand_targets="public/views locales public/js/extra.js lib/models/note.js app.json"
grep -rl 'HedgeDoc' $brand_targets 2>/dev/null | while IFS= read -r f; do
  sed -i 's/HedgeDoc/SpecDoc/g' "$f"
done

# 1b. Notes are specs here. English locale values only: keys stay, they are
#     the lookup strings templates pass to __(). "See releases notes here" is
#     about HedgeDoc release notes, not documents, so it is skipped.
node -e '
const fs = require("fs")
const p = "locales/en.json"
const j = JSON.parse(fs.readFileSync(p))
for (const k in j) {
  if (k === "See releases notes here") continue
  j[k] = j[k].replace(/note/g, "spec").replace(/Note/g, "Spec")
}
fs.writeFileSync(p, JSON.stringify(j, null, 4) + "\n")'
#     Same wording for the few phrases hardcoded in templates. Exact visible
#     strings only; class/data attributes like ui-delete-note never match.
sed -i 's/Delete this note/Delete this spec/g; s/Delete note/Delete spec/g; s/owned this note/owned this spec/g; s/Edit this note/Edit this spec/g' \
  public/views/hedgedoc/body.ejs public/views/hedgedoc/header.ejs public/views/pretty.ejs public/views/slide.ejs

# 2. Keep crediting upstream: the footer "Powered by" anchor must still point
#    at HedgeDoc (AGPL good-faith attribution), so undo the rename on that link.
sed -i 's#hedgedoc\.org">SpecDoc</a>#hedgedoc.org">HedgeDoc</a>#g' public/views/index/body.ejs

# 3. Swap logo and icon assets.
cp -f branding/banner/*.svg public/banner/
cp -f branding/icons/* public/icons/

# 3b. Repaint the hardcoded HedgeDoc orange (#b51f08) in the shared favicon
#     partial: theme-color / TileColor to the brand yellow, the Safari
#     mask-icon tint to the dark gold (visible on Safari's light pinned bar).
sed -i 's/content="#b51f08"/content="#efcb5f"/g' public/views/includes/favicon.ejs
sed -i 's/color="#b51f08"/color="#9a7409"/g' public/views/includes/favicon.ejs public/views/htmlexport.ejs

# 4. The Export menu section only holds hidden save integrations, so drop the
#    whole section server-side to avoid an empty "Export" header.
sed -i 's/if(enableGitHubGist || enableDropBoxSave || enableGitlabSnippets)/if(false)/g' public/views/hedgedoc/header.ejs

# 5. Drop the "Releases" (HedgeDoc changelog) footer link and its separator;
#    it points at upstream release notes, not relevant to a SpecDoc deployment.
#    Keep "Powered by HedgeDoc" and "Source Code" (AGPL attribution + section 13).
sed -i 's# | <a href="<%- serverURL %>/s/release-notes"[^>]*><%= __([^)]*) %></a>##' public/views/index/body.ejs

# 5b. Expose the spec board URL to every template (like serverURL) and add a
#     "Board" link to the editor navbar and the cover nav. Hidden when unset
#     (config default is '').
sed -i '/app.locals.serverURL = config.serverURL/a app.locals.specBoardURL = config.specBoardURL' app.js
sed -i 's#<a class="btn btn-link ui-mode">#<% if (specBoardURL) { %><a class="btn btn-link ui-board" href="<%- specBoardURL %>" target="_blank" rel="noopener" title="Spec board"><i class="fa fa-th fa-fw"></i> Board</a><% } %>\n            \0#' public/views/hedgedoc/header.ejs
sed -i 's#<div class="ui-signin" style="float: right;#<% if (specBoardURL) { %><li class="ui-board"><a href="<%- specBoardURL %>" target="_blank" rel="noopener">Board</a></li><% } %>\n                            \0#' public/views/index/body.ejs

# 6. Hide the remaining non-essential feature UI, and repaint Bootstrap form
#    controls onto the brand palette (no markup edits, rebase-safe).
cat branding/hide-features.css branding/brand-forms.css >> public/css/site.css

# 7. AGPL attribution NOTICE in the image. The running app also links its
#    source via the CMD_SOURCE_URL "Source Code" footer link (AGPL section 13).
cat > NOTICE <<'NOTICE_EOF'
SpecDoc is a fork of HedgeDoc (https://hedgedoc.org), licensed under the GNU
Affero General Public License v3.0 (see LICENSE). SpecDoc keeps that license.

Source for this deployment: set via CMD_SOURCE_URL and shown in the app footer.

HedgeDoc is Copyright the HedgeDoc contributors, AGPL-3.0.
NOTICE_EOF
