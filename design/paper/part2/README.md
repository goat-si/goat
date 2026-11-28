# Part 2 · Providers (Paper page p-7-1) — GOAT 2 redesign

**Status (2026-11-29):** redesigned for GOAT 2. v1 (`916b5ccc`) is the source for FEATURES (see
`providers-inventory.md`, 35 capabilities), not for the look. The earlier v1-look boards and
`scripts/paper/render-v1-boards.mjs` are no longer the source for these screens (the script only reproduces
the v1 look; keep it for v1 parity checks of P2-M's lifted components).

Owner feedback that drove this: the v1 look nests screens (settings page > card > list+detail > cards, then a
modal on top), presets (Oh My Pi, MiniMax) feel bolted on, cloud entries clutter the list, and it looks like T3.

## Brief
Providers is a first-class place, built like Machines (p-8-1): the rail's settings/accounts item opens it; the
256px sidebar is a flat list of the providers you added (one row per account: logo, name · account label,
one status dot + one-line state); the main pane is the selected provider as plain sections. Add a provider is
one catalog in the main pane. No modals, no card-in-card.

## UX principles (drafted, then strengthened with a Gemini 4 Neon review: `providers-neon-review.md`)
1. One frame, zero nesting: sidebar list + main pane, hairline sections; never a modal over a page over a card.
2. Outcome over plumbing: "Ready", "Needs sign-in", "1-click install"; no PATH / ACP Registry / CODEX_HOME on the cover.
3. Every state names its next action (Sign in, Install and add, Update all, Reinstall, Retry).
4. Colour only for status dots (green ready, blue needs you, red broken, amber update). Account labels are text, not colour.
5. Progressive disclosure with truth on the cover: one collapsed "Details" row that prints what's inside
   (program path, N variables, N project overrides).
6. Default path first, escape hatch one click deeper ("Use another way to sign in", "Copy install command",
   "Add a custom agent").
7. List only what you use: the sidebar shows added providers; everything else lives in the catalog.
8. Pickers pick, Providers configure: the model picker never hosts sign-in forms; it routes to Providers.
9. Cloud is opt-in: a local provider with a cloud counterpart gets an "Also run in the cloud" section (off by
   default, "nothing is sent until you turn this on"); pure cloud platforms (Devin Cloud) only via the catalog's
   Cloud filter.

Neon points accepted: no row toggles in the sidebar (on/off lives in the detail header); outcome badges instead
of source tags (Built-in/Preset/Registry) and no shell commands on catalog rows; catalog ordered On this Mac ->
More with All / Ready on this Mac / Cloud filters; Cursor/Claude Cloud also searchable in the catalog (no dead
end for cloud-only users); account label in the row (Codex · Work) for multi-account; Details summary shows
counts; picker routes sign-in to Providers; "Update all" banner; first run lists CLIs detected on this Mac.
Neon points deferred: soft-grouping the sidebar by machine when >1 machine is active (needs Machines data; add
when P2-E/E expose it); install logs behind "Show what failed" only drawn as a link.
Not taken: none rejected outright.

## Boards
| Board | id | Shows | Inventory items |
|---|---|---|---|
| P1 list + detail | 1PBB-2 | Codex · Personal: account, add another account, models, runs on, Details | 1-8, 19-23 |
| P2 sign-in | 1Q0P-2 | Antigravity browser sign-in inline in Account; other methods behind one link | 8-15 |
| P3 add a provider | 1QAN-2 | one catalog: detected, presets, registry, cloud; custom agent link | 24-27, 29 |
| P4 composer picker | 1QM8-2 | favorites, provider rail (signed-out greyed), models + star, reasoning, Open Providers | 32-34 |
| P5 bot model | 1QYE-2 | bot settings Model row + same picker | 35 |
| P6 cloud opt-in | 2LET-2 | Claude detail with "Also run in the cloud" (Claude Cloud, off) | 29 |
| P7 repair / install / update / accounts | 2LEU-2 | Update all banner, Needs repair with Reinstall, reinstall progress + Cancel, add another account | 16-18, 28, 30 (permissions: banner slot) |
| P8 first run | 2LEV-2 | No providers yet + detected CLIs + Add all / Browse | 31 |

Coverage: 35/35 inventory items placed (30 "limited permissions" and 7 "device unavailable" use the same banner
slot shown on P7). Placeholder data only.
