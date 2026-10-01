'use strict'

/**
 * Owner-initiated AI calls (chat, task change, routine, detection, target choice) share one lock.
 * Background notification wording never takes that lock: it yields when an owner call is running
 * and never overlaps another wording request, so it can never refuse the owner's own chat.
 */
function createAILocks() {
  let owner = false, automatic = false
  return {
    async owner(run) {
      if (owner) throw new Error('前のAI応答を待っています')
      owner = true
      try { return await run() } finally { owner = false }
    },
    async automatic(run) {
      if (owner || automatic) throw new Error('前のAI応答を待っています')
      automatic = true
      try { return await run() } finally { automatic = false }
    }
  }
}
module.exports = { createAILocks }
