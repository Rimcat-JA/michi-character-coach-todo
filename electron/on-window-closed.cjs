const sinks = new WeakMap()
/** One 'closed' listener per window no matter how many modules subscribe.
 * Keeps the shutdown cleanup without tripping the listener-count warning. */
function onWindowClosed(win, callback) {
  if (!win || typeof win.on !== 'function' || typeof callback !== 'function') throw new Error('WINDOW_CALLBACK_INVALID')
  let sink = sinks.get(win)
  if (!sink) {
    sink = new Set()
    sinks.set(win, sink)
    const handler = () => {
      sinks.delete(win)
      win.removeListener('closed', handler)
      for (const next of [...sink]) {
        try { next() } catch { /* One failing cleanup never blocks the others. */ }
      }
      sink.clear()
    }
    win.on('closed', handler)
  }
  sink.add(callback)
  return () => { const current = sinks.get(win); if (current) current.delete(callback) }
}
module.exports = { onWindowClosed }
