"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("duckAPI", {
  setIgnoreMouseEvents: (ignore, opts) => ipcRenderer.send("set-ignore-mouse-events", ignore, opts),
  // ask({ provider, text, sessionId, history, systemPrompt }) -> { note, links, sessionId } | { error }
  ask: (payload) => ipcRenderer.invoke("ask-duck", payload),
  getProviderConfig: () => ipcRenderer.invoke("get-provider-config"),
  saveProviderConfig: (cfg) => ipcRenderer.invoke("save-provider-config", cfg),
  getHomeRect: () => ipcRenderer.invoke("get-home-rect"),
  getDisplays: () => ipcRenderer.invoke("get-displays"),
  quit: () => ipcRenderer.send("quit-app")
});
