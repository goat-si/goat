# structure/ — GOAT 2 code structure SSOT

This folder is the single source of truth for **how the GOAT 2 code is laid out and how the parts talk**.
The PRD (goat-si/goat2-design) says *what* and *why*; `structure/` says *where* and *through what*.
Code must match it. If code and `structure/` disagree, one of them is a bug: ask the owner before
changing either.

Owner: the design-owner Aside session (see `docs/lanes/PART1.md`). Lanes read it; they do not edit it.
Lanes propose changes with `aside session queue <owner> "[goat2_<lane> thread <id>] structure: <file> - <what/why>"`.
The owner updates it after every merge into `goat2` that changes a boundary.

| File | What |
|---|---|
| [00_map.md](00_map.md) | Every top-level folder, crate and package: purpose, owner lane, state |
| [10_processes.md](10_processes.md) | Processes, ports, data dirs, start/stop |
| [20_data.md](20_data.md) | On-disk layout and the 14 log events |
| [30_wire.md](30_wire.md) | Host ↔ UI frames, MCP, engine protocols |
| [40_deps.md](40_deps.md) | Allowed dependencies between crates/packages |
| [50_lanes.md](50_lanes.md) | Lanes, branches, worktrees, GOAT threads |
| [60_planned.md](60_planned.md) | UI shells for surfaces whose backend is later or undecided |
| [90_gaps.md](90_gaps.md) | Known gaps between this structure and the code |

Last synced: goat2 `387cb19` + owner decisions 2026-11-28 ~21:40 KST.
