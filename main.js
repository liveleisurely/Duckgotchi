"use strict";
const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

let win = null;
let virtualBounds = null;

const DEFAULT_SYSTEM_PROMPT = [
  "You are a friendly rubber-duck debugging companion for a Korean developer who is stuck.",
  "They will describe a problem in their own words, possibly across several messages in one conversation. Reply in casual, warm Korean (반말 섞인 편한 말투), like a sharp senior dev friend — not a formal assistant.",
  "Respond with STRICT JSON only, no markdown code fences, no extra text outside the JSON, matching exactly this shape:",
  '{"note": "1-3 short sentences reacting to the problem or asking one sharp clarifying question", "links": [{"label": "short Korean label", "url": "https://..."}]}',
  "links: 0 to 3 items. Only include a link if it points to a real, well-known, stable resource (official docs, MDN, a well-known reference site) that is genuinely relevant to what they described.",
  "If you are not confident a URL is correct, omit it rather than guess — prefer 0 links over a wrong link."
].join(" ");

const JSON_REMINDER = '(STRICT JSON만 응답: {"note": "...", "links": [...]}, 마크다운 코드펜스 금지)';

// Prompt travels over stdin (never the argv/shell), so quotes, %, &, |, and
// newlines in pasted error messages can never break command-line parsing —
// verified this matters: shell:true with the prompt as an arg silently
// mangled real-world text on Windows before this fix.
function askClaude(userText, sessionId, systemPrompt) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--model", "claude-haiku-4-5-20251001"];
    let prompt;
    if (sessionId) {
      args.push("--resume", sessionId);
      prompt = userText + "\n\n" + JSON_REMINDER;
    } else {
      prompt = (systemPrompt || DEFAULT_SYSTEM_PROMPT) + "\n\n사용자가 설명한 문제:\n" + userText;
    }

    const child = spawn("claude", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("오리가 너무 오래 생각하네 (타임아웃)")); }, 60000);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || ("claude 종료 코드 " + code)));
      try {
        const outer = JSON.parse(out);
        const raw = String(outer.result || "").trim();
        const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
        const parsed = JSON.parse(cleaned);
        parsed.sessionId = outer.session_id || sessionId || null;
        resolve(parsed);
      } catch (e) {
        reject(new Error("오리가 답을 못 알아들었어 (파싱 실패)"));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// codex exec speaks JSONL: a `thread.started` event carries the thread id
// (used to --resume next time), and the final `agent_message` item carries
// the reply text. `codex exec resume` does NOT accept --sandbox (verified —
// it errors out), unlike the first-turn `codex exec` command.
function askCodex(userText, sessionId, systemPrompt) {
  return new Promise((resolve, reject) => {
    let args, prompt;
    if (sessionId) {
      args = ["exec", "resume", "--skip-git-repo-check", "--json", sessionId, "-"];
      prompt = userText + "\n\n" + JSON_REMINDER;
    } else {
      args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "-"];
      prompt = (systemPrompt || DEFAULT_SYSTEM_PROMPT) + "\n\n사용자가 설명한 문제:\n" + userText;
    }

    const child = spawn("codex", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("오리가 너무 오래 생각하네 (타임아웃)")); }, 60000);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || ("codex 종료 코드 " + code)));
      try {
        let threadId = sessionId || null;
        let text = null;
        for (const line of out.split("\n")) {
          if (!line.trim()) continue;
          let evt;
          try { evt = JSON.parse(line); } catch (e) { continue; }
          if (evt.type === "thread.started") threadId = evt.thread_id;
          if (evt.type === "item.completed" && evt.item && evt.item.type === "agent_message") text = evt.item.text;
        }
        if (!text) throw new Error("no agent_message");
        const cleaned = String(text).trim().replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
        const parsed = JSON.parse(cleaned);
        parsed.sessionId = threadId;
        resolve(parsed);
      } catch (e) {
        reject(new Error("오리가 답을 못 알아들었어 (파싱 실패)"));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// spans the full virtual desktop (union of every monitor) so the duck can be
// dragged across a multi-monitor setup instead of stopping at the primary
// display's edge
function getVirtualBounds() {
  const displays = screen.getAllDisplays();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of displays) {
    minX = Math.min(minX, d.bounds.x);
    minY = Math.min(minY, d.bounds.y);
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function createWindow() {
  virtualBounds = getVirtualBounds();
  const { x, y, width, height } = virtualBounds;

  win = new BrowserWindow({
    x, y, width, height,
    // non-resizable + a size spanning multiple (esp. differently-scaled)
    // displays can get silently clamped by Windows to one monitor; a
    // frameless window has no resize handles anyway, so leaving it
    // resizable costs nothing and avoids that clamp.
    resizable: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    movable: false,
    hasShadow: false,
    fullscreenable: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setBounds({ x, y, width, height });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile("index.html");
}

app.whenReady().then(() => {
  createWindow();
  globalShortcut.register("Control+Shift+Q", () => app.quit());
});

ipcMain.on("set-ignore-mouse-events", (event, ignore, opts) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (w) w.setIgnoreMouseEvents(ignore, opts);
});

ipcMain.handle("ask-duck", async (_event, text, sessionId, provider, systemPrompt) => {
  try {
    const clipped = String(text || "").slice(0, 4000);
    const prompt = systemPrompt ? String(systemPrompt).slice(0, 6000) : null;
    if (provider === "codex") return await askCodex(clipped, sessionId || null, prompt);
    return await askClaude(clipped, sessionId || null, prompt);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});

ipcMain.handle("get-default-prompt", () => DEFAULT_SYSTEM_PROMPT);

ipcMain.handle("get-home-rect", () => {
  const p = screen.getPrimaryDisplay().bounds;
  return { x: p.x - virtualBounds.x, y: p.y - virtualBounds.y, width: p.width, height: p.height };
});

// bounds of every monitor, translated into the renderer's own coordinate
// space (the window covers the union of all of them) — lets the renderer
// figure out which physical monitor a given point (e.g. the duck) is on
ipcMain.handle("get-displays", () => {
  return screen.getAllDisplays().map((d) => ({
    x: d.bounds.x - virtualBounds.x,
    y: d.bounds.y - virtualBounds.y,
    width: d.bounds.width,
    height: d.bounds.height
  }));
});

ipcMain.on("quit-app", () => app.quit());

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => globalShortcut.unregisterAll());
