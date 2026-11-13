const { contextBridge, ipcRenderer } = require('electron');
// 직원 화면(admin.html)에서 window.bultoonDesktop.alert() / ack() 로 호출
contextBridge.exposeInMainWorld('bultoonDesktop', {
  alert: () => ipcRenderer.send('bultoon:alert'),
  ack: () => ipcRenderer.send('bultoon:ack'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
});
