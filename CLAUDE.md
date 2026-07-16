# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

말랑오리 ("Squishy Duck") — a Windows desktop widget built with Electron: a transparent, frameless, always-on-top window spanning every monitor, with a Three.js duck floating on the desktop. You drag/fling it, double-click for random physics reactions, click to chat with it (backed by the real `claude` or `codex` CLI on the user's machine — no API key), and earn XP to unlock cosmetic parts. See `README.md` for the full feature/controls list and `CHANGELOG.md` for the request-by-request history of how the design got here (useful when a change seems to contradict an earlier one — it's probably intentional, check the changelog first).

## Commands

```
npm install        # first run only
npm start           # launch (electron .)
run.bat              # double-click launcher; runs npm install automatically if node_modules is missing
```

There is no build step, bundler, transpiler, test suite, or linter. `index.html`'s `<script type="module">` runs directly in Chromium — a syntax error only surfaces at runtime (in the console, or as a silently blank/broken renderer), not at edit time. Before launching after a nontrivial edit to `index.html`, validate the script block with plain Node rather than guessing:

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('index.html','utf8');
const m = html.match(/<script type=\"module\">([\s\S]*?)<\/script>/);
const stripped = m[1].replace(/^import .*;$/gm, '');
require('fs').writeFileSync('check_tmp.mjs', stripped);
"
node --check check_tmp.mjs && rm check_tmp.mjs
```

`main.js` is plain CommonJS — `node --check main.js` is sufficient there.

**Visually verifying a change**: this is a transparent overlay window, so a normal screenshot tool won't show it meaningfully and the machine's screen may be locked/inaccessible. The reliable pattern used throughout development was a temporary `capturePage()` hook in `main.js`'s `createWindow()`, gated behind an env var, e.g.:

```js
if (process.env.DUCK_DEBUG_SHOT) {
  setTimeout(() => {
    win.webContents.capturePage().then((img) => {
      require("fs").writeFileSync(process.env.DUCK_DEBUG_SHOT, img.toPNG());
    });
  }, 2500);
}
```
then `DUCK_DEBUG_SHOT=/path/to/out.png npx electron .`. Since renderer-scoped variables/functions (defined inside the `<script type="module">`) are not reachable from `executeJavaScript`, drive interactive states for a screenshot by dispatching real DOM events (e.g. `document.getElementById('duckHit').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true}))`) or by poking DOM elements/classes directly — not by calling renderer functions by name. Remove the hook before shipping; it is not present in the checked-in `main.js`.

## Architecture

Three files, no framework: `main.js` (Electron main process), `preload.js` (contextBridge, exposes `window.duckAPI`), `index.html` (the entire renderer — markup, CSS, and a single `<script type="module">` with all app logic). `three` is resolved via an `<script type="importmap">` in `index.html`'s `<head>` mapping the bare specifier `"three"` to `node_modules/three/build/three.module.js`; if any code ever needs `three/addons/*` (e.g. GLTFLoader), the importmap already has that prefix mapped too.

### The click-through window

The window covers the union of **every** monitor (`getVirtualBounds()` in `main.js`), is transparent, and by default calls `setIgnoreMouseEvents(true, {forward:true})` so clicks pass through to whatever's beneath — otherwise it would block the entire desktop. The renderer re-enables mouse events only while the cursor is over an element carrying the `.hit` class, via a single `mousemove` listener that calls `elementFromPoint` and pings `duckAPI.setIgnoreMouseEvents` through IPC (`index.html`, near the top of the module script). Any new interactive UI element MUST be marked `.hit` or it will be visually present but permanently unclickable. `forward:true` is what keeps `mousemove` alive even while events are being ignored — without it the click-through/click-back toggle cannot self-correct.

Because of this architecture, "click outside the panel to dismiss it" does not work the normal way: clicks on the transparent background never reach the renderer at all (they're passed through to the desktop by design, per an explicit product decision — see CHANGELOG). Dismissal has to be via an explicit close button, Escape, or clicking another `.hit` element.

### Multi-monitor window sizing

`resizable: true` is required on the `BrowserWindow` even though the app never lets the user resize it (there's no chrome to drag). A `resizable: false` window sized to span multiple monitors was silently clamped by Windows to a single display — this was a real, hard-to-diagnose bug (see CHANGELOG §8). `win.setBounds(...)` is called explicitly after construction as a second safeguard.

### The duck: a group of 14 independently-leveled parts, not one mesh

Earlier attempts (hand-sculpted primitive composites, a lathed/revolved single mesh, a real photoscanned CC0 glTF model) were each tried and abandoned — full postmortems are in `CHANGELOG.md` §§3, 9–10; don't re-attempt "one polished mesh" expecting a different result without reading why it didn't work out. The current design is deliberately a kit of interchangeable primitives:

- `SHAPES` (7 primitive geometry factories) × `COLORS` (8 hex values) are shared libraries.
- `PARTS` (14 entries: head/body/bill/eyeL/eyeR/wingL/wingR/legL/legR/footL/footR/tail/blush/crest) each declare a fixed local-space anchor (`pos`, optional `scale`, `size`) and a `naturalColor` — the sensible real-world default color for that part (eyes dark, bill orange, etc). Every part starts at `naturalColor`, **not** `COLORS[0]`; a shared default color for every part was tried and made the whole duck read as one undifferentiated blob (CHANGELOG §9).
- Per-part progress (`{level, shapeIdx, colorIdx}`) persists to `localStorage["duckParts"]`. Leveling a part unlocks one additional shape and color option on top of its natural default (`colorForChoice`) — unlocks are additive/permanent, never replace the natural default.
- `blush` and `crest` carry `hiddenAtZero: true` and render nothing at level 0 — they're bonus slots that visibly appear only once unlocked, rather than an always-present default that just changes shape (this was a deliberate fix for the unlock feeling invisible — CHANGELOG §10).
- `rebuildPart(id)` disposes the old mesh/geometry/material and rebuilds from current state; call it after any change to `partState`.

### Shared XP economy

A single `totalXP` pool (`localStorage["duckXP"]`) is earned by asking the duck a question (`askDuck`) and by triggering a double-click reaction (`doReaction`), and spent per-part on-demand (skill-tree style, not auto-applied) via the customize tab in the settings panel. `costForLevel(level) = level * 8`. The XP badge in the corner (`#xpHud`) is deliberately always visible (not tucked inside the right-click settings panel) — hiding the progress indicator made the whole unlock system feel invisible in practice.

### Reaction/physics deformation — squashGroup exists to avoid shearing

`duck` (position + yaw/tilt rotation) → `squashGroup` (all reaction-driven scale, uniform or non-uniform) → `partGroup` (the 14 part meshes). Any double-click reaction (`REACTIONS` in `index.html`) that wants squash/stretch must set scale on `squashGroup`, never on `duck` itself. Because `squashGroup` is a *child* of the yaw-rotated `duck`, its non-uniform scale is always expressed in the duck's own body-relative axes — it stays visually correct no matter which way the duck is currently facing. Applying a non-uniform, world-space-computed scale directly to a rotated object was the earlier failure mode this fixes.

Drag gestures are disambiguated by hold time, not by a separate keybinding: a quick drag moves/flings the duck (`curX/curY` + friction physics in `physicsFrame`); pressing and holding still for ~380ms before moving switches to `holdMode`, where horizontal movement instead accumulates into `duckYaw` (rotate in place, position frozen). A short press-release with negligible movement is a tap; two taps within the debounce window is a double-click (`doReaction`), one tap alone (after the window elapses unmatched) opens the chat bubble (`openChat`).

### AI backends: real CLIs, not an HTTP API

`main.js` shells out to the user's already-authenticated `claude` (Claude Code CLI, `claude -p`) or `codex` (`codex exec`) — no Anthropic/OpenAI API key involved, no billing beyond what the user's own CLI subscription already covers. Two hard-won constraints, both from direct testing (do not "simplify" past them):

- **The prompt is always sent over the child process's stdin, never as a CLI argument.** Passing it via argv let Windows' shell-quoting mangle real user text containing quotes, `%`, or `&` (e.g. pasted error messages). Both `askClaude` and `askCodex` write to `child.stdin` and never put user text in the `args` array.
- **`codex exec resume <id>` does not accept `--sandbox`** (unlike the first-turn `codex exec ... --sandbox read-only`) — passing it errors out. The two branches of `askCodex` intentionally use different flag sets.

Both functions return `{ note, links, sessionId }`, parsed from a JSON contract the LLM is instructed to emit (`DEFAULT_SYSTEM_PROMPT` / `JSON_REMINDER` in `main.js`) — the note/links pair is what the renderer displays. `sessionId` threads through `--resume` (Claude) / `codex exec resume` (Codex) so a chat keeps context across turns; it resets whenever the user switches provider or edits the custom prompt (`saveSettingsBtn` handler in `index.html`). The system prompt itself is user-editable per-provider from the settings panel and persisted to `localStorage["duckSystemPrompt"]`; `main.js` only supplies the fallback default via the `get-default-prompt` IPC handler.

### UI surfaces, all anchored to the duck's live screen position, none of them native dialogs

- `#chatBubble` — speech bubble above/below the duck (flips to below if there's no room above; `positionBubble()`).
- `#thoughtBubble` + `#thoughtDot1-3` — a separate "cloud" bubble for link suggestions, with a 3-dot trail that visually originates at the duck's head (`positionThought()`) — kept as a distinct bubble from the chat text by explicit design request.
- `#settingsOverlay` — opened by right-click, contains two tabs (`tabSettings` / `tabCustomize`) toggled by `.tabBtn` buttons. It centers itself on whichever physical monitor the duck currently occupies, not the center of the full multi-monitor virtual canvas (`displayUnderDuck()` + `duckAPI.getDisplays()`) — centering on the virtual canvas was a real bug when the duck was on a monitor other than the primary one.

All three reposition every animation frame while open (see the tail of `physicsFrame`), since the duck itself can be dragged mid-conversation.

### Known inert leftovers

`assets/duck/` (a downloaded CC0 glTF model + textures) is not referenced by any current code — it's a remnant of an abandoned approach (CHANGELOG §9). Safe to delete; kept only because nothing currently depends on it either way.
