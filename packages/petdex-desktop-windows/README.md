# Petdex Desktop for Windows

A standalone Windows desktop pet companion for Petdex, built with Tauri v2.

## Prerequisites

- Node.js >= 18
- Rust >= 1.70
- Petdex CLI (`npm install -g @crafter-station/petdex-cli`)

## Development

```bash
npm install
npm run tauri-dev
```

## Build

```bash
npm run tauri-build
```

## Features

- Transparent floating window
- Petdex gallery integration
- Claude Code / Codex / Gemini / OpenCode hooks support
- Drag & momentum physics
- Pet picker with virtual scroll
- Bubble notifications
- Deep link support (`petdex://<slug>`)

## Architecture

- **Frontend**: Vanilla JS extracted from Petdex Desktop's `main.zig`
- **Backend**: Rust (Tauri v2)
- **Sidecar**: Petdex Node.js HTTP server (port 7777)
