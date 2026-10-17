const fs = require('fs')
const path = require('path')

function deploymentConfig (env = process.env) {
  const themeDir = env.BOARD_THEME_DIR || ''
  const redirectHosts = (env.BOARD_REDIRECT_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  let origin
  if (redirectHosts.length) {
    origin = new URL(env.SPEC_BOARD_BASE_URL)
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      throw new Error('BOARD_REDIRECT_HOSTS requires an HTTPS origin in SPEC_BOARD_BASE_URL')
    }
    if (redirectHosts.includes(origin.host.toLowerCase())) throw new Error('BOARD_REDIRECT_HOSTS cannot include the canonical host')
  }
  return {
    themeDir,
    name: env.BOARD_NAME || 'specdoc',
    redirect (req) {
      if (!redirectHosts.includes((req.headers.host || '').toLowerCase())) return null
      const url = new URL(req.url, 'http://localhost')
      return origin.origin + url.pathname + url.search
    }
  }
}

function themeAssets (directory) {
  if (!directory) return {}
  const assets = {}
  const types = {
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8'
  }
  function visit (relative = '') {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const file = relative + entry.name
      if (entry.isSymbolicLink()) throw new Error('BOARD_THEME_DIR must not contain symlinks')
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) visit(file + '/')
      else if (entry.isFile() && types[path.extname(file)]) {
        const url = '/theme/' + file.split('/').map(encodeURIComponent).join('/')
        assets[url] = [types[path.extname(file)], fs.readFileSync(path.join(directory, file))]
      }
    }
  }
  visit()
  if (!assets['/theme/theme.css']) throw new Error('BOARD_THEME_DIR must contain theme.css')
  return assets
}

module.exports = { deploymentConfig, themeAssets }
