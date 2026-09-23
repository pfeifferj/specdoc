# BASE is overridden in-cluster to a namespace-local mirror; builds there share
# one egress IP with everything else on the node and would hit Docker Hub's
# anonymous pull limit.
ARG BASE=docker.io/library/node:20-alpine
FROM ${BASE}
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY server.js refs.js prosediff.js favicon.ico favicon-32x32.png favicon-16x16.png apple-touch-icon.png ./
COPY ui.css board.css board.js shell.js ./
COPY notifications.js notification-store.js notification-delivery.js ./
COPY config.js health-state.js lifecycle.js schema-guard.js editor-client.js ./
COPY publication-recovery.js publication-state.js implementation-scan.js ./
COPY roadmap.js roadmap-store.js roadmap-service.js roadmap-ui.js ./
COPY feedback.js feedback-github.js feedback-store.js feedback-ui.js feedback-service.js ./
COPY critic-markup.js critic-source.js critic-context-block.js critic-context-inline.js ./
COPY fonts ./fonts
RUN node -e "require('./server')"
EXPOSE 8080
USER node
CMD ["node", "server.js"]
