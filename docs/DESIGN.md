# GOAT 2 design guidelines

Status: draft 2026-11-28. Read this before drawing a screen or writing a component. Screen SSOT:
Paper [GOAT 봇 워크스페이스 · 봇 홈 — SSOT](https://app.paper.design/file/01M8GDWPDQSBBWW8RMTG12PGCC).
Motion: [MOTION.md](MOTION.md) and the live [motion playground](motion/playground.html).

How the references keep their guidelines, and what we take:

| Product | Where the rules live | What we take |
|---|---|---|
| Hermes Agent (`NousResearch/hermes-agent`, MIT) | `apps/desktop/DESIGN.md`, 656 lines: principles, IA, surfaces, tokens, one Button/Badge, states, motion, checklist | The document shape, "tokens not literals", "style lives in the primitive", "intent before automation", the face clock |
| OpenBot (`CopilotKit/OpenBot`, MIT) | `docs/app-guidelines.md` + a token package + tests that fail the build when a screen breaks the look | One color scheme, numbered look rules, a guard test with a shrinking allowlist, `lib/motion.ts` |
| openmuse (`CopilotKit/openmuse`, MIT) | `docs/EXPERIENCE.md`, 26 lines | Short experience rules: composer stays open, avatar tap = activity, structured review screens |
| Meta Muse / Grok Bot | Design blog posts | Avatar carries state; status answers "what is my agent doing right now"; layered disclosure |

## Principles

1. **Bots first, threads one level down.** The roster is home. A worker thread is a folded row
   in the chat and a list in the overview; it is never hidden, only lowered.
2. **Always say what ran.** Every run shows its provider chip. Model next to it where a person
   chooses or reads results. Full runtime only in Overview → Runtime.
3. **Answer "what is it doing" in layers** (Muse): avatar motion → one-line status → folded run →
   full thread. Each layer is opt-in.
4. **Intent before automation** (Hermes): do not open panes, move focus or navigate because a tool
   produced something.
5. **Tokens, not literals.** No hex, rgb or px in a screen. A new value is a token change.
6. **Style lives in the primitive.** Call sites pick a variant, not override padding or color.
7. **Color means one thing.** Controls stay neutral ink. Hue only for state: `decide` (needs you,
   failed), `done`. Provider marks keep their own brand colors and appear only inside the chip.

## Foundations

| Token | Value | Use |
|---|---|---|
| `--color-background` | `#FFFFFF` | Chat, overview |
| `--color-panel` | `#F7F7F8` | Roster frame |
| `--color-foreground` | `#111113` | Text, primary buttons, working ring |
| `--color-muted-foreground` | `#5E5E64` | Secondary text |
| `--color-faint` | `#8A8A90` | Times, counts, meta |
| `--color-border` | `#ECECEE` | Every hairline |
| `--color-selected` | `#E9E9EC` | Selected roster row (neutral, no accent bar) |
| `--color-decide` | `#E5484D` | Needs-you dot, failed |
| `--color-done` | `#1A9E5C` | Positive diffs, done counts |
| `--font-sans` | Noto Sans KR (Inter fallback) | UI |
| `--font-mono` | Geist Mono | Models, versions, counts |
| Type | 11 / 12 / 13 / 14 / 15 / 16 px | meta / label / row secondary / body / chat / title |
| Radius | 8 / 10 / 12 / 16 / full | control / row / card / approval card / pills, avatars |

Shadows (OpenBot rule): none in the page; a hairline + `shadow-lg` only for things that open
beside their trigger (menus, popovers); `shadow-2xl` only for dialogs.

## Avatar and provider chip

```
44 × 44 box
├─ body        40 × 40 at (0, 0)   shape + two eyes; the bot's own color
├─ needs dot   10 × 10 at (32, 2)  decide, 2px ring in the surface color
├─ chip        20 × 20 at (24, 24) white disc, 2px ring in the surface color, real provider mark
│              12px (Codex, Claude), 13px (Antigravity), 10–11px (Pi, OpenCode)
└─ ring        28 × 28 at (20, 20) only while working; track #DCDCE0, arc ink, 1.2s per turn
```

- Provider marks are lifted from the GOAT codebase (`@goat2/provider-icons`), never redrawn.
- The roster shows the chip only: no version, no machine. Runtime bar and composer: chip + model.
- Overview → Runtime: CLI + version, model + effort, machine, account, access, workspace.

## Folding

| Surface | Folded | Open |
|---|---|---|
| Roster | Avatar rail (dot and chip stay) | Name, status, last line |
| Worker thread in chat | One line: title · steps · chip · model · time · Open thread | Step list; "Open thread" opens the existing coding view |
| Overview | Hidden | Sections fold one by one; empty sections are not drawn; max 3 rows then "See all" |

## Copy

English UI. Short, plain, verb first on buttons ("Merge #7712", "Not now"). A blocked state says
the exact ask ("Needs a Luma login code. Check your phone.").

## Before adding something

- [ ] Uses tokens only, and an existing primitive variant
- [ ] Shows which CLI ran it (chip) if it shows a run
- [ ] State is readable without color (glyph or label)
- [ ] Has a reduced-motion version (see MOTION.md)
- [ ] Empty, loading and error states named
