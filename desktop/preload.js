const { contextBridge, ipcRenderer } = require('electron');
// 只暴露固定控制能力，避免 renderer 取得任意 IPC/文件/命令执行接口。
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  version: '2.4.6',
  close: () => ipcRenderer.invoke('desktop:close'),
  minimize: () => ipcRenderer.invoke('desktop:minimize'),
  browser: Object.freeze({
    list: () => ipcRenderer.invoke('desktop:browser:list'),
    show: id => ipcRenderer.invoke('desktop:browser:show', String(id)),
    hide: () => ipcRenderer.invoke('desktop:browser:hide'),
    setBounds: rect => ipcRenderer.invoke('desktop:browser:bounds', rect),
    back: () => ipcRenderer.invoke('desktop:browser:back'),
    forward: () => ipcRenderer.invoke('desktop:browser:forward'),
    reload: () => ipcRenderer.invoke('desktop:browser:reload'),
    onState: callback => {
      if (typeof callback !== 'function') throw new Error('状态回调无效');
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('desktop:browser-state', listener);
      return () => ipcRenderer.removeListener('desktop:browser-state', listener);
    }
  })
}));

