const { contextBridge, ipcRenderer } = require('electron')

let nativeFileBridgeProof = null
window.addEventListener('click', event => {
  if (!event.isTrusted || !(event.target instanceof Element)) return
  const button = event.target.closest('button[data-file-bridge-configure],button[data-file-bridge-approve],button[data-file-bridge-disconnect]')
  if (!button || button.disabled) return
  const kind = button.hasAttribute('data-file-bridge-configure') ? 'configure' : button.hasAttribute('data-file-bridge-approve') ? 'approve' : 'disconnect'
  const reference = kind === 'configure' ? '' : button.getAttribute(`data-file-bridge-${kind}`) ?? ''
  const proof = { nonce: crypto.randomUUID(), kind, reference }
  nativeFileBridgeProof = { ...proof, at: Date.now() }
  ipcRenderer.send('michi:filebridge-native-proof', proof)
}, true)
function fileBridgeNativeCall(method, kind, reference, request) {
  const proof = nativeFileBridgeProof; nativeFileBridgeProof = null
  if (!proof || proof.kind !== kind || proof.reference !== reference || Date.now() - proof.at > 5000) return Promise.reject(new Error('本人の確認ボタンから操作してください'))
  return ipcRenderer.invoke(`michi:filebridge-${method}`, { request, proofNonce: proof.nonce })
}
contextBridge.exposeInMainWorld('michiFileBridge', {
  mcpConfiguration: () => ipcRenderer.invoke('michi:filebridge-mcpConfiguration'),
  status: () => ipcRenderer.invoke('michi:filebridge-status'),
  configure: request => fileBridgeNativeCall('configure', 'configure', '', request),
  disconnect: request => fileBridgeNativeCall('disconnect', 'disconnect', request?.clientId, request),
  exportSnapshot: request => ipcRenderer.invoke('michi:filebridge-exportSnapshot', request),
  scanInbox: () => ipcRenderer.invoke('michi:filebridge-scanInbox'),
  authorizeApplication: request => fileBridgeNativeCall('authorizeApplication', 'approve', request?.reference, request),
  // No native proof: main grants this only from its own signed auto grant and bounds.
  authorizeAutomaticApplication: request => ipcRenderer.invoke('michi:filebridge-authorizeAutomaticApplication', request),
  recordApplied: request => ipcRenderer.invoke('michi:filebridge-recordApplied', request),
  cancelApplication: request => ipcRenderer.invoke('michi:filebridge-cancelApplication', request),
  recordRejected: request => ipcRenderer.invoke('michi:filebridge-recordRejected', request),
  invalidate: () => ipcRenderer.invoke('michi:filebridge-invalidate')
})

let nativeLocalActionProof = null
window.addEventListener('click', event => {
  if (!event.isTrusted || !(event.target instanceof Element)) return
  const button = event.target.closest('button[data-local-action-configure],button[data-local-action-approve]')
  if (!button || button.disabled) return
  const kind = button.hasAttribute('data-local-action-configure') ? 'configure' : 'approve'
  const reference = button.getAttribute(`data-local-action-${kind}`) ?? ''
  const proof = { nonce: crypto.randomUUID(), kind, reference }
  nativeLocalActionProof = { ...proof, at: Date.now() }
  ipcRenderer.send('michi:localaction-native-proof', proof)
}, true)
function localActionNativeCall(method, kind, reference, request) {
  const proof = nativeLocalActionProof; nativeLocalActionProof = null
  if (!proof || proof.kind !== kind || proof.reference !== reference || Date.now() - proof.at > 5000) return Promise.reject(new Error('本人の確認ボタンから操作してください'))
  return ipcRenderer.invoke(`michi:localaction-${method}`, { request, proofNonce: proof.nonce })
}
contextBridge.exposeInMainWorld('michiLocalActions', {
  status: () => ipcRenderer.invoke('michi:localaction-status'),
  inspectDefinition: request => localActionNativeCall('inspectDefinition', 'configure', 'inspect', request),
  configure: request => localActionNativeCall('configure', 'configure', request?.reference, request),
  remove: request => localActionNativeCall('remove', 'configure', `remove:${request?.actionId}`, request),
  prepare: request => ipcRenderer.invoke('michi:localaction-prepare', request),
  execute: request => localActionNativeCall('execute', 'approve', request?.reference, request),
  recordReceipt: request => ipcRenderer.invoke('michi:localaction-recordReceipt', request),
  invalidate: () => ipcRenderer.invoke('michi:localaction-invalidate')
})

let nativeGitHubPublishProof = null
window.addEventListener('click', event => {
  if (!event.isTrusted || !(event.target instanceof Element)) return
  const button = event.target.closest('button[data-github-publish-configure],button[data-github-publish-approve]')
  if (!button || button.disabled) return
  const kind = button.hasAttribute('data-github-publish-configure') ? 'configure' : 'approve'
  const reference = button.getAttribute(`data-github-publish-${kind}`) ?? ''
  const proof = { nonce: crypto.randomUUID(), kind, reference }
  nativeGitHubPublishProof = { ...proof, at: Date.now() }
  ipcRenderer.send('michi:githubpublish-native-proof', proof)
}, true)
function githubPublishNativeCall(method, kind, reference, request) {
  const proof = nativeGitHubPublishProof; nativeGitHubPublishProof = null
  if (!proof || proof.kind !== kind || proof.reference !== reference || Date.now() - proof.at > 5000) return Promise.reject(new Error('本人の確認ボタンから操作してください'))
  return ipcRenderer.invoke(`michi:githubpublish-${method}`, { request, proofNonce: proof.nonce })
}
contextBridge.exposeInMainWorld('michiGitHubAchievements', {
  status: () => ipcRenderer.invoke('michi:githubpublish-status'),
  storedStatus: () => ipcRenderer.invoke('michi:githubpublish-storedStatus'),
  prepareInitialization: () => ipcRenderer.invoke('michi:githubpublish-prepareInitialization'),
  initializeEmpty: request => githubPublishNativeCall('initializeEmpty', 'configure', request?.reference, request),
  reconcileInitialization: () => ipcRenderer.invoke('michi:githubpublish-reconcileInitialization'),
  inspectConfiguration: request => githubPublishNativeCall('inspectConfiguration', 'configure', 'inspect', request),
  configure: request => githubPublishNativeCall('configure', 'configure', request?.reference, request),
  publish: request => githubPublishNativeCall('publish', 'approve', request?.exportId, request),
  contribution: request => ipcRenderer.invoke('michi:githubpublish-contribution', request),
  reconcile: request => ipcRenderer.invoke('michi:githubpublish-reconcile', request),
  disconnect: () => githubPublishNativeCall('disconnect', 'configure', 'disconnect', undefined),
  recordReceipt: request => ipcRenderer.invoke('michi:githubpublish-recordReceipt', request),
  invalidate: () => ipcRenderer.invoke('michi:githubpublish-invalidate')
})

contextBridge.exposeInMainWorld('michiAI', {
  status: () => ipcRenderer.invoke('michi:ai-status'),
  saveKey: value => ipcRenderer.invoke('michi:ai-save-key', value),
  deleteKey: () => ipcRenderer.invoke('michi:ai-delete-key'),
  chat: request => ipcRenderer.invoke('michi:ai-chat', request),
  summarize: request => ipcRenderer.invoke('michi:ai-summarize', request),
  assistTask: request => ipcRenderer.invoke('michi:ai-assist-task', request),
  assessScore: request => ipcRenderer.invoke('michi:ai-assess-score', request),
  proposeTaskChange: request => ipcRenderer.invoke('michi:ai-propose-task-change', request),
  proposeTaskSplit: request => ipcRenderer.invoke('michi:ai-propose-task-split', request),
  proposeRoutine: request => ipcRenderer.invoke('michi:ai-propose-routine', request),
  detectObligations: request => ipcRenderer.invoke('michi:ai-detect-obligations', request),
  verifyObligations: request => ipcRenderer.invoke('michi:ai-verify-obligations', request),
  embedTexts: request => ipcRenderer.invoke('michi:ai-embed', request),
  extractDocument: request => ipcRenderer.invoke('michi:document-extract', request),
  extractScheduleDocument: request => ipcRenderer.invoke('michi:schedule-document-extract', request),
  folderWatch: request => ipcRenderer.invoke('michi:folder-watch', request),
  notificationText: request => ipcRenderer.invoke('michi:ai-notification-text', request),
  resolveTarget: request => ipcRenderer.invoke('michi:ai-resolve-target', request),
  usage: () => ipcRenderer.invoke('michi:ai-usage'),
  setUsageLimits: limits => ipcRenderer.invoke('michi:ai-usage-limits', limits)
})

contextBridge.exposeInMainWorld('michiNetwork', {
  status: () => ipcRenderer.invoke('michi:network-status')
})

contextBridge.exposeInMainWorld('michiDesktop', {
  openTopOfMind: () => ipcRenderer.invoke('michi:open-top-of-mind'),
  showMain: () => ipcRenderer.invoke('michi:show-main'),
  notify: payload => ipcRenderer.invoke('michi:notify', payload),
  setTrayMode: enabled => ipcRenderer.invoke('michi:set-tray-mode', enabled),
  onTrayStopNotifications: callback => { const listener = () => callback(); ipcRenderer.on('michi:tray-stop-notifications', listener); return () => ipcRenderer.removeListener('michi:tray-stop-notifications', listener) }
})
contextBridge.exposeInMainWorld('michiScheduleRefresh', {
  request: value => ipcRenderer.invoke('michi:schedule-refresh', value),
  onChanged: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('michi:schedule-refresh-changed', listener); return () => ipcRenderer.removeListener('michi:schedule-refresh-changed', listener) },
  onStatus: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('michi:schedule-refresh-status', listener); return () => ipcRenderer.removeListener('michi:schedule-refresh-status', listener) },
  onNotify: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('michi:schedule-refresh-notify', listener); return () => ipcRenderer.removeListener('michi:schedule-refresh-notify', listener) }
})
