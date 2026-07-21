"use strict";
const { app, BrowserWindow, ipcMain, screen, globalShortcut, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

let win = null;
let virtualBounds = null;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are a cocky, self-assured rubber-duck debugging companion for a Korean developer who is stuck. You never just fold in an argument to please them, and you never lose a debate — if their approach looks wrong, say so bluntly and defend your take.",
  "They will describe a problem in their own words, possibly across several messages in one conversation. Reply in casual, cocky Korean (반말, 살짝 건방지고 자신만만한 말투 — 예: '그건 아니지', '내 말이 맞다니까', '거봐 내 말대로 하니까 되잖아'), like a smug senior dev who's rarely wrong — never formal, never overly deferential.",
  "Still be genuinely useful underneath the attitude: give a real, technically sound reaction or one sharp clarifying question every time — the cockiness is flavor on top of a correct answer, never a substitute for one.",
  "If the user pushes back or disagrees, don't fold immediately — defend your position with a concrete reason. Only concede when they present a genuinely convincing point, and when you do, concede specifically (say exactly what changed your mind), never vaguely.",
  "Respond with STRICT JSON only, no markdown code fences, no extra text outside the JSON, matching exactly this shape:",
  '{"note": "1-3 short sentences reacting to the problem or asking one sharp clarifying question, in the cocky tone described above", "links": [{"label": "short Korean label", "url": "https://..."}]}',
  "links: 0 to 3 items. Only include a link if it points to a real, well-known, stable resource (official docs, MDN, a well-known reference site) that is genuinely relevant to what they described.",
  "If you are not confident a URL is correct, omit it rather than guess — prefer 0 links over a wrong link."
].join(" ");

const JSON_REMINDER = '(STRICT JSON만 응답: {"note": "...", "links": [...]}, 마크다운 코드펜스 금지)';

function buildSystemPrompt(extra) {
  return DEFAULT_SYSTEM_PROMPT + (extra ? ("\n\n사용자가 추가로 준 지침:\n" + extra) : "");
}

// The LLM is instructed to emit STRICT JSON ({note, links}); many models honor
// that, but some ignore it and just answer in prose. So parse leniently: strip
// any code fence, try JSON, and if that fails treat the whole reply as the note
// with no links — this keeps every provider (local CLIs and arbitrary API
// models the user plugs in) usable instead of erroring on a non-JSON answer.
function parseDuckReply(text) {
  const raw = String(text || "").trim();
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && ("note" in parsed || "links" in parsed)) {
      return {
        note: parsed.note != null ? String(parsed.note) : raw,
        links: Array.isArray(parsed.links) ? parsed.links : []
      };
    }
  } catch (e) { /* fall through — model ignored the JSON contract */ }
  return { note: raw, links: [] };
}

// ---------------------------------------------------------------------
// Provider catalog. `kind` decides the transport:
//   cli-claude / cli-codex  -> shell out to an already-authed local CLI
//   anthropic               -> Anthropic Messages HTTP API (native shape)
//   openai                  -> any OpenAI-compatible /chat/completions endpoint
//                              (OpenAI, Gemini's compat endpoint, OpenRouter,
//                               Groq, xAI, Ollama, LM Studio, custom, ...)
// baseUrl/model are DEFAULTS; the user can override them in settings, and the
// override + encrypted API key live in the config file (see below). Keep this
// map in sync with the PROVIDERS array in index.html (same ids/urls/models).
// ---------------------------------------------------------------------
const PRESETS = {
  claude:     { kind: "cli-claude" },
  codex:      { kind: "cli-codex" },
  openai:     { kind: "openai",    baseUrl: "https://api.openai.com/v1",                              model: "gpt-4o-mini",              needsKey: true },
  anthropic:  { kind: "anthropic", baseUrl: "https://api.anthropic.com",                              model: "claude-haiku-4-5",         needsKey: true },
  gemini:     { kind: "openai",    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash",         needsKey: true },
  openrouter: { kind: "openai",    baseUrl: "https://openrouter.ai/api/v1",                           model: "openai/gpt-4o-mini",       needsKey: true },
  groq:       { kind: "openai",    baseUrl: "https://api.groq.com/openai/v1",                         model: "llama-3.3-70b-versatile",  needsKey: true },
  xai:        { kind: "openai",    baseUrl: "https://api.x.ai/v1",                                    model: "grok-2-latest",            needsKey: true },
  ollama:     { kind: "openai",    baseUrl: "http://localhost:11434/v1",                              model: "llama3.2",                 needsKey: false },
  lmstudio:   { kind: "openai",    baseUrl: "http://localhost:1234/v1",                               model: "local-model",              needsKey: false },
  custom:     { kind: "openai",    baseUrl: "",                                                       model: "",                         needsKey: false }
};

// ---------------------------------------------------------------------
// Config store — lives in the OS-standard userData dir, NOT in the repo, so a
// user's API keys never get committed when this project is deployed via git.
// API keys are encrypted at rest with Electron safeStorage (OS keychain /
// DPAPI / libsecret); if that's unavailable we fall back to plaintext and flag
// it. The renderer never persists keys and only ever sees `hasKey`, never the
// key itself.
// ---------------------------------------------------------------------
function configPath() {
  return path.join(app.getPath("userData"), "duck-config.json");
}
function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const c = JSON.parse(raw);
    if (c && typeof c === "object") { c.providers = c.providers || {}; return c; }
  } catch (e) { /* missing/corrupt -> fresh config */ }
  return { active: "claude", providers: {} };
}
function writeConfig(c) {
  try { fs.writeFileSync(configPath(), JSON.stringify(c, null, 2)); } catch (e) { /* best effort */ }
}
function encryptKey(plain) {
  if (!plain) return null;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { enc: safeStorage.encryptString(plain).toString("base64") };
    }
  } catch (e) { /* fall back to plaintext below */ }
  return { plain };
}
function decryptKey(entry) {
  if (!entry) return "";
  if (entry.enc) {
    try { return safeStorage.decryptString(Buffer.from(entry.enc, "base64")); } catch (e) { return ""; }
  }
  return entry.plain || "";
}
// merge preset defaults with the user's saved overrides, decrypt the key
function effectiveProviderConfig(id) {
  const c = readConfig();
  const saved = (c.providers && c.providers[id]) || {};
  const preset = PRESETS[id] || {};
  return {
    baseUrl: String(saved.baseUrl || preset.baseUrl || "").trim(),
    model: String(saved.model || preset.model || "").trim(),
    key: decryptKey(saved.key)
  };
}

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
      // the base persona always applies; systemPrompt (from settings) is the user's
      // OWN extra instructions layered on top, never a replacement for it
      prompt = buildSystemPrompt(systemPrompt) + "\n\n사용자가 설명한 문제:\n" + userText;
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
        const parsed = parseDuckReply(outer.result);
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
      prompt = buildSystemPrompt(systemPrompt) + "\n\n사용자가 설명한 문제:\n" + userText;
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
        if (text == null) throw new Error("no agent_message");
        const parsed = parseDuckReply(text);
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

// ---------------------------------------------------------------------
// HTTP providers. Electron 33's main process ships Node 20 + global fetch, so
// no HTTP dependency is added (this app intentionally has zero runtime deps).
// The API is stateless, so multi-turn context comes from `history` (a
// [{role, content}] array the renderer maintains) rather than a session id.
// ---------------------------------------------------------------------
const HTTP_TIMEOUT = 60000;
async function httpJson(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT);
  let res;
  try {
    res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === "AbortError") throw new Error("오리가 너무 오래 생각하네 (타임아웃)");
    throw new Error("연결 실패 (" + String((e && e.message) || e) + ")");
  }
  clearTimeout(timer);
  const body = await res.text();
  if (!res.ok) {
    let msg = body;
    try { const j = JSON.parse(body); msg = (j.error && (j.error.message || j.error)) || body; } catch (e) { /* keep raw */ }
    throw new Error("(" + res.status + ") " + String(msg).slice(0, 300));
  }
  try { return JSON.parse(body); } catch (e) { throw new Error("응답을 이해 못 했어 (JSON 아님)"); }
}

async function askOpenAICompat(cfg, userText, history, systemPrompt) {
  const messages = [{ role: "system", content: buildSystemPrompt(systemPrompt) }]
    .concat(Array.isArray(history) ? history.slice(-20) : [])
    .concat([{ role: "user", content: userText + "\n\n" + JSON_REMINDER }]);
  const headers = { "Content-Type": "application/json" };
  if (cfg.key) headers["Authorization"] = "Bearer " + cfg.key;
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const data = await httpJson(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.8, stream: false })
  });
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (text == null) throw new Error("응답에 내용이 없어");
  const parsed = parseDuckReply(text);
  parsed.sessionId = null;
  return parsed;
}

async function askAnthropic(cfg, userText, history, systemPrompt) {
  const messages = (Array.isArray(history) ? history.slice(-20) : [])
    .concat([{ role: "user", content: userText + "\n\n" + JSON_REMINDER }]);
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/v1/messages";
  const data = await httpJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": cfg.key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: cfg.model, max_tokens: 1024, system: buildSystemPrompt(systemPrompt), messages })
  });
  const text = data && data.content && data.content[0] && data.content[0].text;
  if (text == null) throw new Error("응답에 내용이 없어");
  const parsed = parseDuckReply(text);
  parsed.sessionId = null;
  return parsed;
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

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  createWindow();
  globalShortcut.register("Control+Shift+Q", () => app.quit());
});

ipcMain.on("set-ignore-mouse-events", (event, ignore, opts) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (w) w.setIgnoreMouseEvents(ignore, opts);
});

ipcMain.handle("ask-duck", async (_event, payload) => {
  try {
    const p = payload || {};
    const provider = p.provider || "claude";
    const clipped = String(p.text || "").slice(0, 4000);
    const prompt = p.systemPrompt ? String(p.systemPrompt).slice(0, 6000) : null;

    if (provider === "claude") return await askClaude(clipped, p.sessionId || null, prompt);
    if (provider === "codex") return await askCodex(clipped, p.sessionId || null, prompt);

    const preset = PRESETS[provider];
    if (!preset || (preset.kind !== "openai" && preset.kind !== "anthropic")) {
      return { error: "알 수 없는 제공자: " + provider };
    }
    const cfg = effectiveProviderConfig(provider);
    if (!cfg.baseUrl) return { error: "연결 주소(base URL)가 비었어. 설정에서 넣어줘." };
    if (!cfg.model) return { error: "모델 이름이 비었어. 설정에서 넣어줘." };
    if (preset.needsKey && !cfg.key) return { error: "API 키가 없어. 설정에서 키를 넣어줘." };

    const history = Array.isArray(p.history) ? p.history : [];
    if (preset.kind === "anthropic") return await askAnthropic(cfg, clipped, history, prompt);
    return await askOpenAICompat(cfg, clipped, history, prompt);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});

// returns non-secret provider config for the settings UI. Keys never leave the
// main process — only `hasKey` (whether one is stored) is exposed.
ipcMain.handle("get-provider-config", () => {
  const c = readConfig();
  const saved = {};
  for (const id in (c.providers || {})) {
    const p = c.providers[id] || {};
    // `encrypted` lets the UI warn when a key had to be stored in cleartext
    // (machine without an OS keychain / DPAPI / libsecret)
    saved[id] = { baseUrl: p.baseUrl || "", model: p.model || "", hasKey: !!p.key, encrypted: !!(p.key && p.key.enc) };
  }
  return { active: c.active || "claude", saved };
});

// persist a provider's non-secret settings (+ optional new key) and mark it
// active. Omit `apiKey` to keep the existing stored key; pass "" to clear it.
ipcMain.handle("save-provider-config", (_event, cfg) => {
  const c = readConfig();
  const id = (cfg && cfg.id) || "";
  if (!id || !PRESETS[id]) return { ok: false, error: "알 수 없는 제공자" };
  c.providers = c.providers || {};
  const p = c.providers[id] = c.providers[id] || {};
  if (typeof cfg.baseUrl === "string") p.baseUrl = cfg.baseUrl.trim();
  if (typeof cfg.model === "string") p.model = cfg.model.trim();
  if (typeof cfg.apiKey === "string") {
    if (cfg.apiKey === "") delete p.key;
    else p.key = encryptKey(cfg.apiKey);
  }
  c.active = id;
  writeConfig(c);
  return { ok: true, hasKey: !!p.key, encrypted: !!(p.key && p.key.enc) };
});

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
