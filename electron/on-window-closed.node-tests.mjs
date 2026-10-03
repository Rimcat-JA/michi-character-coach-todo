import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
const { onWindowClosed } = createRequire(import.meta.url)('./on-window-closed.cjs')

test('many modules share one closed listener and all cleanups run once', () => {
  const win = new EventEmitter()
  const calls = []
  const stops = Array.from({ length: 12 }, (_, i) => onWindowClosed(win, () => { calls.push(i) }))
  assert.equal(win.listenerCount('closed'), 1)
  win.emit('closed')
  assert.deepEqual(calls, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  win.emit('closed')
  assert.equal(calls.length, 12)
  assert.equal(typeof stops[0], 'function')
})

test('unsubscribe removes one cleanup while others stay', () => {
  const win = new EventEmitter()
  const calls = []
  const stop = onWindowClosed(win, () => { calls.push('gone') })
  onWindowClosed(win, () => { calls.push('stays') })
  stop()
  win.emit('closed')
  assert.deepEqual(calls, ['stays'])
})

test('a throwing cleanup never blocks the others', () => {
  const win = new EventEmitter()
  const calls = []
  onWindowClosed(win, () => { throw Error('synthetic') })
  onWindowClosed(win, () => { calls.push('second') })
  win.emit('closed')
  assert.deepEqual(calls, ['second'])
})

test('invalid window or callback fails closed', () => {
  assert.throws(() => onWindowClosed(null, () => {}), /WINDOW_CALLBACK_INVALID/)
  assert.throws(() => onWindowClosed(new EventEmitter(), null), /WINDOW_CALLBACK_INVALID/)
})
