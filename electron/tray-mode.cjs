'use strict'

/**
 * Optional tray residency (off by default). Pure decisions only: notification rules stay in the
 * renderer's common evaluator and the main-process OS guard. An explicit quit always ends the process.
 */
function createTrayMode() {
  let enabled = false, quitting = false
  return {
    setEnabled(value) { if (typeof value !== 'boolean') throw new Error('トレイ常駐の設定が不正です'); enabled = value; return enabled },
    get enabled() { return enabled },
    get quitting() { return quitting },
    /** Main window close button: hide only while resident and no explicit quit is in progress. */
    onClose() { return enabled && !quitting ? 'hide' : 'close' },
    /** Tray menu 終了, Windows session-end or app.quit() (before-quit): every later close really closes. */
    requestQuit() { quitting = true; return ['close-top-of-mind', 'destroy-tray', 'quit'] },
    onWindowAllClosed(platform = process.platform) { return quitting || !enabled ? (platform === 'darwin' && !quitting ? 'stay' : 'quit') : 'stay' },
    /** Second launch or tray 開く: bring the hidden or minimized main window back. */
    showActions(window) { return !window || window.destroyed ? [] : [...(window.minimized ? ['restore'] : []), 'show', 'focus'] },
    /** The 60s renderer tick must keep running while hidden in the tray, and only then. */
    backgroundThrottling() { return !enabled }
  }
}
module.exports = { createTrayMode }
