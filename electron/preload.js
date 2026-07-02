const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ocrTerminal", {
  getConfig: () => ipcRenderer.invoke("app:get-config")
});
