# 261012 GOAT sidebar two-line thread row

Owner: coordinator (claude-opus-5-5) · implementer/reviewer: sol subagents (gpt-6.1-sol)
Base: origin/dev cfb14b0333048c8a9dbf837225d9b1dc1d5a433c · publish: direct push to `dev` (user-authorized 2026-10-12; branch unprotected)

## Outcome

The sidebar **card** thread row (`SidebarThreadRow` variant "card", apps/web/src/components/Sidebar.tsx) becomes a Codex-style two-line row, matching the approved mockup:

- Line 1: title (flex-1, truncates) · [worktree icon when `thread.worktreePath`] · [status slot, rightmost]. When the status slot is occupied the worktree icon sits one slot to its left; when empty the worktree icon is rightmost.
- Status slot (icon-only; the text label stays as sr-only `role="status"`):
  - working (incl. active goal) → small ring spinner; rotation `steps(8)` ~0.9s, `motion-reduce:animate-none` (same precedent as the row's terminal pulse).
  - unread completion ("Done") → 8px blue dot.
  - approval / input / limited / failed → existing glyphs at size-3.5 with existing hues, no label.
  - waiting → muted static CircleDashed glyph.
  - woke → existing dismiss button, icon-only (aria-label kept).
  - none → empty (time label removed from cards; slim rows keep time).
  - Hover/focus actions (discard draft, snooze, settle/un-settle) keep the existing slot mechanics and cross-fade.
- Line 2: folder name left (basename of `project.workspaceRoot`, fallback `projectDisplayName`) · right: device cluster.
  - Remote environment (`environmentId !== currentEnvironmentId`): connection dot (only when not connected, existing component) + Globe icon tinted by a stable per-environment hue + short device name.
  - Local environment: short device name only.
  - PR badge (clickable) sits on line 2 just before the device cluster when present.
- Short device name = first token of the environment label split on whitespace/`.`/`-`/`_`, apostrophes removed ("juns-MacBook-Pro" → "juns", "Jun's MacBook Pro" → "Juns"); full label via `title`. Hue = FNV-1a hash of environmentId into a fixed 8-class palette that excludes blue (blue is reserved for the done dot). Both are pure helpers in `Sidebar.logic.ts` with focused tests.
- Removed from the card row: project favicon, project label line, branch line, diff seam, terminal icon, provider stack, working duration. Branch/terminal/provider are already in `SidebarThreadTooltip`; the diff seam is dormant (see amendment 6).
- Height: card body `h-[3.375rem]` (20 + 2 + 16 + 2×8 = 54px), `contain-intrinsic-size:auto_54px`; drag fallback in `Sidebar.drag.ts` 82 → 58 (54 + li py-0.5) with comment. `SidebarDraftRow` card uses the same height and two-line shape (line 1 pen + preview + discard, line 2 folder name).

## Out of scope

Slim rows, search-result rows, LegacySidebar, mobile app, contracts/server, settings for device aliases or colors.

## Files

apps/web/src/components/Sidebar.tsx, apps/web/src/components/Sidebar.logic.ts, apps/web/src/components/Sidebar.logic.test.ts, apps/web/src/components/Sidebar.drag.ts (+ its test only if a fixture encodes 82).

## Verification

- `vp test run apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/Sidebar.drag.test.ts`
- targeted typecheck of apps/web and lint of touched files.
- No browser verification (not requested; AGENTS.md requires asking first).

## Risks

- Spinner is a running animation; AGENTS.md discourages continuous repaint. User explicitly requested the spinner after the conflict was flagged; mitigated with 8-step rotation and reduced-motion off.
- Hosted app (no local env) shows a globe on every row — intended: every row is remote there.
- Short-name collisions (e.g. two hosts with the same first token) are disambiguated by hue and full-name tooltip.

## Audit round 1 amendments (sol reviewer, VERDICT FAIL → folded)

1. **Pin and draft stay.** Line 1 order: [draft pen indicator when `hasUnsentDraft`] · title · [pin indicator (passive or clickable unpin, unchanged logic)] · [worktree icon] · [status slot]. Existing `draftIndicator` / `pinIndicator` elements are reused as-is.
2. **Empty status slot releases width.** Drop `min-w-8` from the resting slot; when `topStatus` is null the slot has zero resting width so the worktree icon is rightmost. Hover/focus actions keep their existing cross-fade and reclaim width (`static` on hover/focus-visible). Woke stays pointer-enabled beside the actions; snooze-menu pinning and dismissal propagation unchanged.
3. **Wrapper boundaries unchanged.** `<li>` keeps sortable props + file drop handlers; inner root keeps ref, role, aria, handlers; sweep still hides (not unmounts) the slot and renders `dragDestination`; drag destination while dragging; `JumpHintBadge`; delegated children stay outside the fixed-height body; `accessibleTitle`, regeneration sr-only status and label-only live regions keep their semantics (status label text moves to sr-only `role="status"`; "Goal"/"Working" precedence unchanged).
4. **Drag geometry and tests are mandatory.** Replace all 82 constants in `Sidebar.drag.ts` (~L151-156) with 58 and update the comment; update `Sidebar.drag.test.ts` default fixture (L34) and the missing-card fallback expectation (L811-826, 62.5 → 44.5 at 0.75 scale). Nested-height and scaled-layout coverage preserved.
5. **Fallbacks.** `sidebarFolderName(path)`: OS-independent; splits on both `/` and `\\`, ignores trailing separators, returns the last nonempty segment; for a root (`/`, `C:\\`) or empty input returns null so the caller falls back to `projectDisplayName`, then nothing. `sidebarShortDeviceName(label)`: null/blank label → null (device cluster hides the name; globe still shows for remote); otherwise first token, apostrophes removed; if that leaves an empty token, the trimmed full label.
6. **Diff.** `latestRunDiff` always returns null today, so nothing visible moves. The card stops rendering the diff seam; no tooltip/contracts work. Remove `latestRunDiff` only if it becomes unused (lint).
7. Intrinsic sizing (`contain-intrinsic-size:auto_54px`) stays on the inner root.

## Audit round 2 (NEAR-PASS, folded)

8. When the resting status is empty, the line-1 trailing gap after the worktree icon is suppressed (e.g. slot uses negative margin / gap handled per child) while action controls stay mounted; spacing returns on hover/focus.
9. Every geometry-dependent expectation in `Sidebar.drag.test.ts` is updated (e.g. L109 83/46 → 59/22, L665 −46 → −22), preserving nested-height and scaling coverage.

## Result (2026-10-12)

- Implemented by sol worker (gpt-6.1-sol) in 3 rounds (main build, dead duration helpers, dead scratch-label wiring + duration predicate); plan audited FAIL → NEAR-PASS → final diff NEAR-PASS by a separate sol reviewer, all findings folded.
- Removed as dead after the redesign: WorkingDuration, SidebarProviderStack, latestRunDiff, resolveWorkingStartedAt, formatWorkingDurationLabel, shouldShowSidebarV2Duration, scratchMachineLabel wiring.
- Verification on the committed tree: `vp test run Sidebar.logic.test.ts Sidebar.drag.test.ts` 249 passed; `apps/web tsc --noEmit` 0; `vp lint` on touched files 0 errors, warnings 29 → 28 vs base (all pre-existing); `vp fmt --check` 0; `knip --workspace apps/web --exports` no Sidebar findings (3 pre-existing unrelated exports in globalAgentStore.ts / sshWorktreeSubmission.ts).
- Not done: browser/visual verification (AGENTS.md requires asking first); mobile and LegacySidebar unchanged.
