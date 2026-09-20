function createLifecycle ({ deadline = 25000, exit = code => process.exit(code), clock = globalThis } = {}) {
  const controller = new AbortController()
  const pending = new Set()
  let stopping = false
  const track = work => {
    const promise = Promise.resolve(work)
    pending.add(promise)
    promise.then(() => pending.delete(promise), () => pending.delete(promise))
    return promise
  }
  async function shutdown ({ closeServer, closePool, stopTimers = () => {} }) {
    if (stopping) { exit(1); return }
    stopping = true
    const hard = clock.setTimeout(() => exit(1), deadline)
    stopTimers()
    controller.abort(new Error('Server is draining'))
    try {
      await closeServer()
      while (pending.size) await Promise.allSettled([...pending])
      await closePool()
      clock.clearTimeout(hard)
      exit(0)
    } catch {
      clock.clearTimeout(hard)
      exit(1)
    }
  }
  return { track, shutdown, get stopping () { return stopping }, signal: controller.signal }
}

module.exports = { createLifecycle }
