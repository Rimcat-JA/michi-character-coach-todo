import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const { createTrayMode } = require('./tray-mode.cjs')

test('default OFF: closing the window closes and quits as before; renderer may be throttled', () => {
  const mode = createTrayMode()
  assert.equal(mode.enabled, false)
  assert.equal(mode.onClose(), 'close')
  assert.equal(mode.onWindowAllClosed('win32'), 'quit')
  assert.equal(mode.backgroundThrottling(), true)
})
test('tray residency hides on close and keeps the 60s tick running without throttling', () => {
  const mode = createTrayMode(); mode.setEnabled(true)
  assert.equal(mode.onClose(), 'hide')
  assert.equal(mode.onWindowAllClosed('win32'), 'stay')
  assert.equal(mode.backgroundThrottling(), false)
})
test('an explicit quit always ends the process and closes the Top of Mind window first', () => {
  const mode = createTrayMode(); mode.setEnabled(true)
  assert.deepEqual(mode.requestQuit(), ['close-top-of-mind', 'destroy-tray', 'quit'])
  assert.equal(mode.onClose(), 'close')
  assert.equal(mode.onWindowAllClosed('win32'), 'quit')
  mode.setEnabled(true); assert.equal(mode.onClose(), 'close')
})
test('second launch or tray 開く restores the hidden or minimized single instance', () => {
  const mode = createTrayMode()
  assert.deepEqual(mode.showActions({ destroyed: false, minimized: true }), ['restore', 'show', 'focus'])
  assert.deepEqual(mode.showActions({ destroyed: false, minimized: false }), ['show', 'focus'])
  assert.deepEqual(mode.showActions(null), [])
  assert.deepEqual(mode.showActions({ destroyed: true, minimized: false }), [])
})
test('only booleans can change the residency setting', () => {
  const mode = createTrayMode()
  for (const value of ['true', 1, null, undefined, {}]) assert.throws(() => mode.setEnabled(value))
  assert.equal(mode.enabled, false)
})
test('Windows session end (before-quit is not emitted) is treated as an explicit quit', () => {
  const mode = createTrayMode(); mode.setEnabled(true)
  mode.requestQuit()
  assert.equal(mode.onClose(), 'close')
  assert.equal(mode.onWindowAllClosed('win32'), 'quit')
})
// Static wiring checks only (no Electron launch, not a real-device test).
const mainSource = readFileSync(new URL('./main.cjs', import.meta.url), 'utf8')
test('second launch restores the main window through showMain, never the first window in the list (Top of Mind)', () => {
  const handler = mainSource.match(/app\.on\('second-instance',[^\n]*\n?/)?.[0] ?? ''
  assert.match(handler, /showMainWindow/)
  assert.doesNotMatch(mainSource, /getAllWindows\(\)\[0\]/)
  assert.match(mainSource, /showMainWindow = showMain/)
})
test('main window listens for Windows session-end and never delays query-session-end', () => {
  assert.match(mainSource, /win\.on\('session-end', \(\) => \{ trayMode\.requestQuit\(\)/)
  assert.doesNotMatch(mainSource, /query-session-end'[^\n]*preventDefault/)
})
