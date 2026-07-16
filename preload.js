"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("duckAPI", {
  setIgnoreMouseEvents: (ignore, opts) => ipcRenderer.send("set-ignore-mouse-events", ignore, opts),
  ask: (text, sessionId, provider, systemPrompt) => ipcRenderer.invoke("ask-duck", text, sessionId, provider, systemPrompt),
  getHomeRect: () => ipcRenderer.invoke("get-home-rect"),
  getDisplays: () => ipcRenderer.invoke("get-displays"),
  getDefaultPrompt: () => ipcRenderer.invoke("get-default-prompt"),
  quit: () => ipcRenderer.send("quit-app")
});
