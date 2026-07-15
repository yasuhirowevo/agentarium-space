# Agentarium Space

**English** | [日本語](./README.ja.md)

A desktop app for Windows and macOS that lets you watch local **Claude Code** and
**Codex CLI** sessions as glowing creatures beneath a nighttime star chart.

Within each project's "tide pool," glowing session orbs drift slowly. Tool calls
send ripples across the surface, thinking sessions breathe with a soft halo, and
inactive sessions close their eyes and sink toward the edge. Sub-agents appear as
smaller lights orbiting their parent and dissolve into particles when their work is done.

## Usage

Node.js 22.12 or later is required. To try Agentarium Space without installing an
additional package manager, use the npm version bundled with Node.js.

### npm (quick start)

```bash
npm install
npm start        # Launch the Electron app
npm run web      # Open the per-launch URL printed to the terminal
npm run scan     # Print the current state as JSON for debugging
npm test         # Run the tests
```

### pnpm (use the lockfile)

This repository uses `pnpm-lock.yaml` to pin dependency versions.

```bash
pnpm install --frozen-lockfile
pnpm start        # Launch the Electron app
pnpm run web      # Open the per-launch URL printed to the terminal
pnpm run scan     # Print the current state as JSON for debugging
pnpm test         # Run the tests
```

Environment variables:

- `AGENTARIUM_PORT` — listening port (default: 41414)
- `AGENTARIUM_WINDOW_MIN` — activity window to display, in minutes (default: 60)
- `AGENTARIUM_DEBUG` — set to 1 to print parser and other debug logs to stderr

## Reading the display

- **Ring (tide pool)** = a project. The project name and Git branch appear at the top center
- **Orb** = a session. Warm colors = Claude Code / cool colors = Codex
- **Ripples + bright core** = a tool is running. Its name and target appear in the nameplate status line
- **Breathing halo** = thinking / **medium glow** = waiting for input / **dimmed + closed eyes** = idle
- **Orbiting smaller lights** = sub-agents. They orbit their parent and disappear in a particle burst when complete; a light traveling along the parent link indicates activity
- **Nameplate** = the session name and current activity (tool name: target and elapsed time). New messages appear as leader-line callouts
- **Header HUD** = current time / status counts / SYNC (time since the last update) / events-per-minute sparkline / LINK status
- **SECTOR label** = a project's tide pool (`SECTOR-A ─ NAME ─ N UNITS`). The full-height LIVE STREAM module shows recent activity
- Click an orb to open its instrument panel (agent tree / status timeline / cwd / branch / live stream). Runs longer than 10 minutes show `LONG RUN`; disconnections show `LINK LOST`

## How it works

- Tails `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/*.jsonl` in
  **read-only** mode, builds session state, and sends it to the UI over WebSocket
- Runs entirely locally, with no external network requests or telemetry
  (listens only on 127.0.0.1; a random token is generated for each launch, and HTTP
  Host / WebSocket Origin validation prevents cross-origin reads from other websites)
- Stops rendering completely while the window is hidden and supports
  `prefers-reduced-motion`

## Documentation

The following project documents are currently available in Japanese:

- [DESIGN.md](./DESIGN.md) — canonical design specification
- [PHILOSOPHY.md](./PHILOSOPHY.md) — design philosophy and rationale; start here when taking over development
- [AGENTS.md](./AGENTS.md) — minimal guide for AI coding agents

## Notes

- This is an **unofficial** project and is not affiliated with Anthropic or OpenAI.
  It depends on each CLI's internal log format, so CLI updates may break the display;
  unknown formats are ignored so the app can keep running
- Only use session logs that you are authorized to read
- Claude Code sub-agents launched with `run_in_background` may not be trackable
  (known limitation)
- Claude context-window usage is approximated using a default window size of
  200000 tokens

## License

[MIT](./LICENSE)
