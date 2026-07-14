# syntax=docker/dockerfile:1
# HedgeDoc 1.x (bexelbie CriticMarkup fork, rebased onto upstream master by rebase.sh)
# Node pinned to 20: upstream CI target; Sequelize 5 breaks on Node 26's url.parse.
# Copied into the rebased source tree by rebase.sh; build with the tree as context.

FROM node:20-bookworm AS build
WORKDIR /app
RUN corepack enable
# .yarnrc.yml pins yarnPath to .yarn/releases; yarn.lock references .yarn/patches.
# Both must land before install or it fails.
COPY .yarnrc.yml package.json yarn.lock ./
COPY .yarn/releases ./.yarn/releases
COPY .yarn/patches ./.yarn/patches
RUN yarn install --immutable
COPY . .
# SpecDoc rebrand + feature-hide applied here so the source tree stays
# upstream-clean; branding/ and overlay.sh are staged into the tree by rebase.sh.
RUN bash overlay.sh
RUN yarn build
# drop dev deps (webpack et al); native prod deps stay built for bookworm glibc
RUN yarn workspaces focus --production && yarn cache clean

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /hedgedoc
COPY --from=build /app ./
COPY --from=build /app/config.json.example ./config.json
USER node
EXPOSE 3000
CMD ["node", "app.js"]
