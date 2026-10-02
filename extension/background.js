import { buildCapsule, readSelectedFragment } from './capture-core.js'
const capsules = new Map()
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create({ id: 'michi-selection', title: 'michi：選んだ引用を確認', contexts: ['selection'] }))
})
export async function captureSelection(tabId, selectedText = null) {
  let record = null
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: readSelectedFragment })
    // The context-menu snapshot remains usable if focus changed during the menu click.
    if (selectedText !== null && (!result?.quote || result.quote !== selectedText)) throw Error('選択が変わりました。同じ引用を選び直してください。')
    record = { capsule: buildCapsule(result), expiresAt: Date.now() + 5 * 60000 }
  } catch (error) { record = { error: error instanceof Error ? error.message : '引用を取得できませんでした。' } }
  for (const [id, value] of capsules) if (!value.expiresAt || value.expiresAt <= Date.now()) capsules.delete(id)
  if (capsules.size >= 20) throw Error('確認中の引用を閉じてください。')
  const id = crypto.randomUUID(); capsules.set(id, record)
  await chrome.windows.create({ type: 'popup', url: chrome.runtime.getURL('confirm.html') + '#' + id, width: 700, height: 650 })
  return { id, ...record }
}
chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === 'michi-selection' && Number.isInteger(tab?.id)) void captureSelection(tab.id, info.selectionText).catch(() => {}) })
chrome.action.onClicked.addListener(tab => { if (Number.isInteger(tab.id)) void captureSelection(tab.id).catch(() => {}) })
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const prefix = chrome.runtime.getURL('confirm.html')
  if (sender.id !== chrome.runtime.id || !sender.url || sender.url.split('#')[0] !== prefix || !message || typeof message.id !== 'string' || sender.url !== prefix + '#' + message.id || Object.keys(message).length !== 2 || !['preview','save','cancel'].includes(message.action)) return false
  const record = capsules.get(message.id)
  if (!record || record.capsule && record.expiresAt <= Date.now()) { capsules.delete(message.id); reply({ error: '引用の確認が失効しました。もう一度引用を選んでください。' }); return false }
  if (message.action === 'preview') { reply(record); return false }
  if (message.action === 'cancel') { capsules.delete(message.id); reply({ canceled: true }); return false }
  if (!record.capsule) { reply({ error: record.error }); return false }
  const raw = JSON.stringify(record.capsule, null, 2)
  // Browser's explicit Save As dialog is the final save choice. Nothing is sent to michi or a network.
  chrome.downloads.download({ url: 'data:application/json;charset=utf-8,' + encodeURIComponent(raw), filename: 'michi-web-selection-' + message.id.slice(0,8) + '.json', saveAs: true }).then(downloadId => { capsules.delete(message.id); reply({ downloadId }) }).catch(() => reply({ error: '保存を取り消したか、ファイルを保存できませんでした。' }))
  return true
})
