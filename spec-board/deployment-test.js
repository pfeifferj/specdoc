const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { deploymentConfig, themeAssets } = require('./deployment')

const request = (host, url = '/', method = 'GET') => ({ headers: { host }, url, method })
assert.equal(deploymentConfig({}).name, 'specdoc')
assert.equal(deploymentConfig({}).redirect(request('old.example')), null)
assert.deepEqual(themeAssets(''), {})

const env = { BOARD_NAME: 'Example specs', BOARD_REDIRECT_HOSTS: 'old.example, older.example', SPEC_BOARD_BASE_URL: 'https://specs.example' }
const deployment = deploymentConfig(env)
assert.equal(deployment.name, 'Example specs')
assert.equal(deployment.redirect(request('OLD.example', '/spec/a%2Fb?ns=owner%2Frepo&t=token')), 'https://specs.example/spec/a%2Fb?ns=owner%2Frepo&t=token')
assert.equal(deployment.redirect(request('older.example', '/unsub?t=signed', 'POST')), 'https://specs.example/unsub?t=signed')
assert.equal(deployment.redirect(request('specs.example')), null)
assert.equal(deployment.redirect(request('old.example.attacker.test')), null)
assert.equal(deployment.redirect({ headers: { 'x-forwarded-host': 'old.example' }, url: '/' }), null)
assert.equal(new URL(deployment.redirect(request('old.example', '//attacker.test/path'))).origin, 'https://specs.example')
for (const origin of ['http://specs.example', 'https://user:pass@specs.example', 'https://specs.example/path', 'https://specs.example?q=1', 'https://specs.example#hash', 'https://old.example']) {
  assert.throws(() => deploymentConfig({ ...env, SPEC_BOARD_BASE_URL: origin }))
}
assert.throws(() => deploymentConfig({ BOARD_REDIRECT_HOSTS: 'old.example' }))

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-theme-'))
const saved = Object.fromEntries(['BOARD_NAME', 'BOARD_THEME_DIR', 'BOARD_REDIRECT_HOSTS'].map(key => [key, process.env[key]]))
function page () {
  delete require.cache[require.resolve('./server')]
  return require('./server').basicPage('Specifications', '<h1>Specifications</h1>')
}
try {
  delete process.env.BOARD_NAME
  delete process.env.BOARD_THEME_DIR
  delete process.env.BOARD_REDIRECT_HOSTS
  const defaults = page()
  assert.ok(defaults.includes('<title>Specifications · specdoc</title>'))
  assert.ok(defaults.includes('/apple-touch-icon.png'))
  assert.ok(!defaults.includes('/theme/'))

  assert.throws(() => themeAssets(directory), /theme.css/)
  fs.mkdirSync(path.join(directory, 'fonts'))
  fs.writeFileSync(path.join(directory, 'theme.css'), '@font-face { font-family: Example; src: url("fonts/Example.woff2"); }')
  fs.writeFileSync(path.join(directory, 'fonts/Example.woff2'), 'fixture')
  fs.writeFileSync(path.join(directory, '.private.txt'), 'hidden')
  fs.writeFileSync(path.join(directory, 'private.json'), '{}')
  process.env.BOARD_THEME_DIR = directory
  process.env.BOARD_NAME = 'Example <specs>'
  const withoutIcon = page()
  assert.ok(withoutIcon.includes('/theme/theme.css?v='))
  assert.ok(withoutIcon.includes('/apple-touch-icon.png'))
  assert.ok(withoutIcon.includes('Example &lt;specs&gt;'))
  assert.ok(!withoutIcon.includes('Example <specs>'))

  fs.writeFileSync(path.join(directory, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const assets = themeAssets(directory)
  assert.equal(assets['/theme/icon.svg'][0], 'image/svg+xml')
  assert.equal(assets['/theme/fonts/Example.woff2'][0], 'font/woff2')
  assert.equal(assets['/theme/.private.txt'], undefined)
  assert.equal(assets['/theme/private.json'], undefined)
  const themed = page()
  assert.ok(themed.includes('/theme/icon.svg?v='))
  assert.ok(!themed.includes('/apple-touch-icon.png'))
  assert.ok(themed.includes('Powered by specdoc'))
  fs.symlinkSync(path.join(directory, 'theme.css'), path.join(directory, 'linked.css'))
  assert.throws(() => themeAssets(directory), /symlinks/)
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  delete require.cache[require.resolve('./server')]
}
console.log('deployment configuration, redirects, custom assets and page shell: ok')
