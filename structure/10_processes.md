# 10 Processes

```mermaid
flowchart LR
  subgraph APP["GOAT 2 (Dev).app — Electron"]
    MAIN["main: windows only"]
    R["renderer: apps/web"]
  end
  HOST["goat2-host (Rust bin)"]
  subgraph ENG["one process group per thread"]
    C1["codex app-server"]
  end
  MAIN -- "spawn + supervise, kill group on quit" --> HOST
  R -- "WebSocket 127.0.0.1 + token (30_wire)" --> HOST
  HOST -- "stdio JSON-RPC" --> C1
  C1 -- "MCP HTTP 127.0.0.1 + token" --> HOST
  HOST --> FS[("~/.goat2-dev/ (20_data)")]
```

| Process | Started by | Lives | Notes |
|---|---|---|---|
| Electron main | user | until quit | no thread work; no IPC data path for threads |
| renderer | main | per window | talks to the host directly over WebSocket |
| `goat2-host` | main | until app quit | quitting the app ends the work; writes `host.json` (pid, port, generation); on start: cleans leftover groups from `host.json`, settles runs, regenerates index epoch |
| `codex app-server` | host | per thread; stopped after 10 min idle | own process group, `nice -n 10` for agent commands, memory limit per group |

| Build | App | Bundle id | Data dir | Host port |
|---|---|---|---|---|
| Dev (Part 1) | `/Applications/GOAT 2 (Dev).app` | `si.goat.goat2.dev` | `~/.goat2-dev` | set by lane G, not 3773/3774 (GOAT v1) |
| Release (later) | `GOAT 2.app` | `si.goat.goat2` | `~/.goat2` | later |

GOAT v1 Nightly is a separate app with its own data (`~/.goat/desktop-nightly`); nothing is shared.
