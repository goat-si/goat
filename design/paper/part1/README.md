# Paper exports for Part 1 (generated, do not hand-edit)

Source: Paper file `01M8GDWPDQSBBWW8RMTG12PGCC` ("GOAT 봇 워크스페이스"), exported 2026-11-28 with the
in-page API: `get_jsx({nodeId, includeNodeIds:false})` -> `<id>.jsx`, `get_screenshot({nodeId, scale:1})` -> `<id>.jpg`.
`manifest.json` lists id, page, board name and size. Paper owns the look; code follows these boards 1:1
(docs/PAPER.md). Re-export through the design owner when a board changes; lanes do not edit Paper.

| Board | What Part 1 builds from it |
|---|---|
| 2R-1 봇 홈 — SSOT | default first screen: 44px rail (main bot only + "…"), bot sidebar, bot chat, right Overview |
| 1KL4-1 레일에 봇 추가 | rail "…" -> search popover |
| 1FKW-0 봇 고정 | pinned bot tiles at the top of the sidebar, drag to pin/reorder |
| FF-1 사이드바 접힘 | collapsed sidebar |
| 12P-1 콜드 스타트 | send-first: "Sent · GOAT starts when … connects" |
| 25D-0 작업 열림 | worker threads in the right panel (Overview -> Threads) |
| U8-1 상태 노트 | state rules (blue dot, counts, faces) |
| 2D0-1 봇 얼굴 | face shapes/colours, `@goat2/bot-face` |
| 2PU-1 새 봇 | new bot face picker |
| 1N65-1 T0 스레드 모드 첫 진입 | v1 Activity sidebar + v1 composer; GOAT 2 adds the "Updating · N of M machines" line |
| 1NEM-1 T1 스레드 Chat | v1 thread view: Activity sidebar (Priority/Threads/Working), breadcrumb header, timeline (user bubble, Worked for fold + work rows, reply, Working for), v1 composer |
| 1OXX-1 T4 대기 메시지 | T1 + v1 QueuedRunsControl banner (Queued, count, row with Edit / Steer / Delete) |
| 1NPV-1 T2 멀티플렉서 2×2 | Planned (roadmap 5): panes = v1 thread column; v1 terminal-split borders; blue ring on the pane that needs you |
| 1OE0-1 T3 멀티플렉서 1+2 | Planned: same panes, 1 + 2 layout |

Re-exported 2026-11-28 ~21:35 KST after the top bar went to **40px** on every desktop board (owner: the
rail is 44px, so the top bar is 40px; supersedes the earlier 52px rule).

Rule overrides newer than some boards: one blue dot `#0169CC` + black rail counts (no red `--color-decide`
/ green `--color-done`), moving face instead of spinners, English copy first, top bar 40px.

**Thread timeline rendering is GOAT v1's, not redrawn:** the working row, work-log groups and fold labels
in C2Y-0 / 1MFK-1 are illustrations. Lift v1's components as-is (`~/Developer/goat` `origin/dev`
`apps/web/src/components/chat/`: `TimelineWorkGroupRows.tsx` `WorkingTimelineRow` ("Working for <timer>",
shimmer, bottom border), work-log entry rows, `TurnFoldLabel.tsx` ("Worked for {duration}")), record them in
`docs/PROVENANCE.md`. The boards decide layout around the timeline, v1 decides how the timeline looks.

**The old prototype UI** (apps/web before lane F: 290px list sidebar, no rail, red "Needs you") is obsolete.
These exports are the latest UI.

**Thread mode boards redrawn from GOAT v1 code (2026-11-28 ~22:20 KST).** T0, T1, T4, T2, T3 were rebuilt from a
code-derived spec of v1 `origin/dev` 916b5ccc (`components/Sidebar.tsx` Activity view, `chat/ChatHeader.tsx`,
`MessagesTimeline.tsx`, `TimelineWorkGroupRows.tsx`, `WorkLog.tsx`, `TurnFoldLabel.tsx`, `ChatComposer.tsx`,
`ComposerSurface.tsx`, `QueuedRunsControl.tsx`, Solar Linear icons, `-apple-system` font). Only the GOAT 2 frame
(40px top bar, 44px rail) and the Updating line are GOAT 2. v1 keeps its own colours inside the timeline and composer
(diff +/- counts, Full access chip, stop button); the "Approval" label is GOAT 2 blue. When code and board differ on a
v1 component, v1 code wins.

**Workspace reaches the window bottom (owner, 2026-11-28 ~22:35 KST).** The sidebar and main pane run flush to the
bottom and right edges of the window: no 8px bottom/right inset; the workspace keeps its rounded **left** corners (top-left and bottom-left, 14px)
and has **no bottom or right border line**: borders are top + left only, so the bottom-left curve ends cleanly at the
window's bottom edge (owner correction ~22:35 KST). All desktop boards were changed and the bot home
boards re-exported.
