// Preload script — exposes safe APIs to renderer
const { contextBridge, ipcRenderer } = require('electron');

// No context isolation in current setup (nodeIntegration: true)
// This file can be extended if contextIsolation is enabled
