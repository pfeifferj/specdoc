FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY server.js favicon.ico favicon-32x32.png favicon-16x16.png apple-touch-icon.png ./
COPY fonts ./fonts
EXPOSE 8080
USER node
CMD ["node", "server.js"]
