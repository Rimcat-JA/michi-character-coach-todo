const fs = require('node:fs')
const path = require('node:path')
/** This fixture override is unreachable in a packaged build and cannot send real tokens. */
function githubQAFetch({ app, endpoint = process.env.MICHI_QA_GITHUB_EMULATOR, fetchImpl = globalThis.fetch }) {
  const disabled = { enabled: false, fetchImpl }
  if (app.isPackaged !== false || typeof endpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/?$/.test(endpoint)) return disabled
  let base, profile, documents
  try {
    base = new URL(endpoint)
    profile = fs.realpathSync(app.getPath('userData')); documents = fs.realpathSync(app.getPath('documents'))
    const relative = path.relative(documents, profile), parts = relative.split(path.sep)
    const index = parts.findIndex((name, i) => name === 'qa-reminders-profile' && parts[i - 1] === 'work')
    if (relative.startsWith('..') || path.isAbsolute(relative) || parts[0] !== 'Codex' || index < 2) return disabled
  } catch { return disabled }
  const token = 'qa_' + 'a'.repeat(36)
  return { enabled: true, fetchImpl: async (url, init = {}) => {
    const target = new URL(url)
    if (target.origin !== 'https://api.github.com' || target.username || target.password || new Headers(init.headers).get('authorization') !== 'Bearer ' + token) throw Object.assign(new Error('QA_GITHUB_EXTERNAL_OR_TOKEN_BLOCKED'), { code: 'QA_GITHUB_EXTERNAL_OR_TOKEN_BLOCKED' })
    const response = await fetchImpl(base.origin + target.pathname + target.search, { ...init, redirect: 'error' })
    const result = new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers })
    Object.defineProperty(result, 'url', { value: url }); return result
  } }
}
module.exports = { githubQAFetch }
