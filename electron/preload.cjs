const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('michiAI', {
  status: () => ipcRenderer.invoke('michi:ai-status'),
  saveKey: value => ipcRenderer.invoke('michi:ai-save-key', value),
  deleteKey: () => ipcRenderer.invoke('michi:ai-delete-key'),
  chat: request => ipcRenderer.invoke('michi:ai-chat', request),
  summarize: request => ipcRenderer.invoke('michi:ai-summarize', request)
})
