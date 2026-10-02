const { createFolderWatch } = require('./folder-watch.cjs')
function installFolderWatchIPC({ ipcMain, dialog, win, assertFrame, readDatabase }) {
  let scope = null
  const service = createFolderWatch({ active: async () => {
    const settings = await readDatabase(win, 'settings', 'main'), state = await readDatabase(win, 'datasetState', 'main')
    return Boolean(settings && (!scope || scope === `${settings.profileId}:${settings.datasetId}`) && (!state || state.mode === 'active'))
  } })
  ipcMain.handle('michi:folder-watch', async (event, request) => {
    assertFrame(event)
    const keys = request?.action === 'start' || request?.action === 'list' ? ['action'] : request?.action === 'stop' ? ['action', 'id'] : request?.action === 'read' ? ['action', 'id', 'candidateId'] : ['action', 'id', 'candidateId', 'sha256']
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).length !== keys.length || keys.some(key => !Object.hasOwn(request, key)) || keys.some(key => typeof request[key] !== 'string' || request[key].length > 200)) throw new Error('監視操作が不正です')
    if (request.action === 'start') {
      const settings = await readDatabase(win, 'settings', 'main')
      const currentScope = `${settings.profileId}:${settings.datasetId}`
      if (scope && scope !== currentScope) { service.close(); scope = null }
      const selected = await dialog.showOpenDialog(win, { title: '本人が監視する資料フォルダーを選ぶ', properties: ['openDirectory'] })
      if (selected.canceled) return null
      scope = currentScope
      return service.start(selected.filePaths[0])
    }
    if (request.action === 'stop') { service.stop(request.id); return true }
    if (request.action === 'list') return service.list()
    if (request.action === 'read') return service.read(request.id, request.candidateId)
    if (request.action === 'accept') { service.accept(request.id, request.candidateId, request.sha256); return true }
    throw new Error('監視操作が不正です')
  })
  win.on('closed', () => service.close())
  return service
}
module.exports = { installFolderWatchIPC }
