# Repository Guidelines

## Project Structure & Module Organization
This repo is a small Electron app with no framework layer. The main files are:
- `main.js`: Electron main process, window setup, IPC, and CLI integration.
- `preload.js`: exposes the limited `window.duckAPI` bridge.
- `index.html`: renderer UI, styles, and app logic in a single module script.
- `assets/duck/`: duck model files and textures.
- `run.bat`: Windows double-click launcher.
- `README.md`, `CHANGELOG.md`, `CLAUDE.md`: project notes and behavior history.

## Build, Test, and Development Commands
- `npm install`: install dependencies on a fresh checkout.
- `npm start`: launch the app with Electron.
- `run.bat`: convenience launcher for Windows; installs dependencies if needed.
- `node --check main.js`: syntax-check the main process file.
- For `index.html`, validate the module script before running if you changed it significantly.

## Coding Style & Naming Conventions
Use plain JavaScript with CommonJS in `main.js` and `preload.js`, and ES modules in the renderer script. Keep formatting consistent with the existing code: 2-space indentation, semicolon-terminated statements, double quotes, and descriptive camelCase identifiers. Prefer small, direct functions over abstractions. Name renderer DOM hooks by purpose, such as `chatBubble` or `settingsOverlay`, and keep asset names lowercase with underscores only when needed.

## Testing Guidelines
There is no formal test suite or linting setup. Verify changes by:
- launching with `npm start`,
- checking the Electron main process with `node --check main.js`,
- manually exercising the affected UI path in the renderer,
- confirming any asset changes still load from `assets/duck/`.

## Commit & Pull Request Guidelines
Commit messages in this repo use a short, prefixed style with a scope and date, for example `feat(widget, 260716): 데스크탑 오리 위젯 초기 커밋`. Keep commits focused and descriptive. Pull requests should explain the user-visible change, note any validation performed, and include screenshots or screen recordings for UI work when practical.

## Security & Configuration Tips
This app shells out to local `claude` and `codex` CLIs. Do not hardcode API keys or assume network access. If you change IPC or window behavior, keep the click-through overlay behavior intact so the desktop remains usable.
