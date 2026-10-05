// Context bridge — the only API surface the renderer can reach.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mvp', {
  openVideo: () => ipcRenderer.invoke('dialog:openVideo'),
  openSubtitle: () => ipcRenderer.invoke('dialog:openSubtitle'),
  readText: (filePath) => ipcRenderer.invoke('file:readText', filePath),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),

  getKey: (engine) => ipcRenderer.invoke('key:get', engine),
  setKey: (engine, value) => ipcRenderer.invoke('key:set', engine, value),

  reencode: (opts) => ipcRenderer.invoke('reencode:start', opts),
  onReencodeProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('reencode:progress', handler);
    return () => ipcRenderer.removeListener('reencode:progress', handler);
  },

  extractAudioChunk: (opts) => ipcRenderer.invoke('audio:extractChunk', opts),
  extractBgmStem: (opts) => ipcRenderer.invoke('audio:extractBgmStem', opts),

  // SenseVoice on-device speech recognition & emotion detection
  checkSenseVoiceModel: () => ipcRenderer.invoke('sensevoice:checkModel'),
  downloadSenseVoiceModel: () => ipcRenderer.invoke('sensevoice:downloadModel'),
  onSenseVoiceProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('sensevoice:download-progress', handler);
    return () => ipcRenderer.removeListener('sensevoice:download-progress', handler);
  },
  transcribeSenseVoice: (opts) => ipcRenderer.invoke('audio:transcribeSenseVoice', opts),

  openPath: (p) => ipcRenderer.invoke('app:openPath', p)
});
