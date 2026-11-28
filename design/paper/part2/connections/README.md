# Part 2 · 머신 연결 (Machines) boards

Paper file `01M8GDWPDQSBBWW8RMTG12PGCC`, page **"Part 2 · 머신 연결" (`p-8-1`)**. Redesign of GOAT v1 Connections +
Fleet for GOAT 2. v1 (`916b5ccc1b2`) is the source of **features and copy facts**, not of the look. Every v1
capability is listed in [`../connections-inventory.md`](../connections-inventory.md) (63 items) with the board or
disclosure where it lives now; nothing is dropped.

## Design brief

- **IA:** the rail's Machines item. Sidebar (256px, `#F7F7F7`) = machine list: Overview, This Mac, Your machines
  (status dot on the machine icon: green online, gray off/reconnecting, red unreachable, blue = needs you), Adding,
  Cloud (coming soon), "Add a machine" at the bottom. Main pane = the selected machine. No settings nav, so no
  second left column.
- **House style:** GOAT 2 frame (40px top bar, 44px rail, workspace flush bottom/right, both left corners 14px,
  border top+left 0.5px `#E2E2E2`), SF Pro, neutral black/gray controls, color only for status, no side accent bars.
- **Copy:** plain words for a non-developer ("Let other devices connect", "How GOAT reaches it", "What this Mac can
  do there"). Technical detail (ports, interfaces, Tailscale HTTPS, fingerprints, MCP URL, trace ID, fix hints)
  sits behind a **Details** disclosure or the `…` menu.
- **States:** every state names its next action (UX-STATE-01): update, pair again, check again, retry, start fresh.

## Boards

| Board | Paper id | Covers (inventory) |
|---|---|---|
| M1 Machines — this Mac | `1RMD-2` | A1-A4, A7, A9-A10, B2-B3, C1-C4, C6-C7, C9-C12 (C2 port/C3/C5/C6/C9/C11/C12 in Details) |
| M2 Machine detail — Mac Studio, menu open | `1RWE-2` | A6-A8, B1, B5, C12, D1-D6, D8 (menu: rename, icon, copy, switch off, forget host, remove) |
| M3 Add a machine — choose how | `1S8H-2` | E1-E3, E12, E4 (adding row) |
| M4 Add over SSH — checks + sign-in prompt | `1SHN-2` | E4-E8 (prompt inline instead of a dialog; fix hints in Details) |
| M5 Pair with a link or QR | `1T69-2` | C8, E10, D2 |
| M6 Problems | `1TLF-2` | A3, A5, B4, D7, D9-D11, E9, E11, F1-F2, C9 (out of sync) |
| M7 Overview — all machines | `1U8U-2` | G1-G11, A10 |

## Loading rule (owner, 2026-11-29): never load everything at once

The overview and the machine list must not fetch all machines' threads or full status in one call. Design
contract for lanes E / P2-E / F:

1. **One small subscription per screen, pushed by the host.** `subscribe_machines` sends a short summary per machine
   (name, kind, status, running/waiting counts, load/memory/disk percent, alert codes, version), then only **deltas**
   when a machine's summary changes. No polling loop in the UI.
2. **Each machine reports on its own.** The local host fans out to linked machines and forwards each answer as its
   own delta; rows appear as machines answer ("Still connecting" skeleton until then). A slow or dead machine never
   blocks the others, and machines that don't answer are not counted (G5).
3. **Detail on demand.** Thread lists, subagents, routes, permissions, quota windows and diagnosis load only for the
   machine you open, paged (threads 20 at a time), and unsubscribe when you leave.
4. **Graph view uses the same summary stream**, drawing machines and counts; threads appear only for the machine you
   expand.

## Not run

- dev-design lint: not run on these boards (Paper-generated JSX, no project HTML/CSS written).
