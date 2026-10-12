# GOAT

GOAT is a desktop, web, and mobile control surface for the coding agents on your machine. It runs your existing Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity setups, lets you review their changes, and keeps the work reachable from other devices.

GOAT is a fork of [T3 Code](https://github.com/pingdotgg/t3code) and shares its git history. Upstream changes arrive by merge each cycle; [devlog/_chase](./devlog/_chase/README.md) records how far GOAT has followed and where it deliberately differs.

## What GOAT adds

- A global agent that works across projects and threads.
- Agent tools named `goat_*` on an MCP server called GOAT.
- The `goat` command line, with SSH hosts kept under `~/.goat`.
- SSH hosts as first-class environments: GOAT ships its runtime to the host and lets agents start and follow threads there.
- A desktop app with its own identity, data folder, and update feed, so it installs beside an upstream T3 Code without sharing state.

## Installation

> [!WARNING]
> Install and authenticate at least one provider before starting a thread:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

Desktop builds and the `goat` command line are published as [releases of this repository](https://github.com/goat-si/goat/releases). After installing the CLI, run `goat` to start the server and open the local web app. `goat service install` keeps it running in the background, `goat update` moves to a newer release, and `goat --help` has the full reference.

## Documentation

User guides live in [docs/user](./docs/user). The maintainer map of the current system is [structure/INDEX.md](./structure/INDEX.md).

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run GOAT as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## Development

GOAT uses Vite+, so install the global `vp` command-line tool first.

```bash
# macOS / Linux
curl -fsSL https://vite.plus | bash
```

```powershell
# Windows
irm https://vite.plus/ps1 | iex
```

Then install dependencies with `vp i` and start the server and web app with `vp run dev`. Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR.

## License

MIT. GOAT keeps the original T3 Code copyright notice in [LICENSE](./LICENSE).
