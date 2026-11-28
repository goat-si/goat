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
| LXD-0 T0 스레드 모드 첫 진입 | cached rows + "Updating · N of M" |
| C2Y-0 T1 스레드 Chat | thread view with the GOAT chat renderer |
| 1MFK-1 T4 대기 메시지 | queued messages banner above the composer (v1 QueuedRunsControl): header list icon + "Queued" + count + chevron; rows grip, truncated text, Edit, Send now (promote to steer), Delete |

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
