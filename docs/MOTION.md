# Bot motion

Status: draft 2026-11-28. Live reference: [motion/playground.html](motion/playground.html)
(open it with any static server: `python3 -m http.server -d docs/motion`). Code:
`@goat2/bot-face` (`facePose`, `blendPose`, `reducedPose`, motion tokens).

## Where this comes from

- **Grok Bot**: the avatar carries the lifecycle. Calm at rest, acknowledges work, "kicks into gear",
  changes when waiting or blocked, settles when done. Three dots were too little; a written step
  made people want every step. Motion first, hover for the current action.
- **Meta Muse**: the status pill was the first thing designed; it answers "what is my agent doing
  right now". Layers: simple status → short description → activity list → technical detail.
  Muse acknowledges a complex request before starting so nobody wonders if it is stuck.
- **Hermes Agent** (`hermes-bots/avatar.tsx`, MIT): a shared "face clock" draws every bot face.
  Moods idle / think / work, each a pose function of time (turn, tilt, roll, gaze, blink, three
  dots). A mood change blends from the last painted pose over 0.4s (ease-out quad). The clock is
  frame-budgeted, pauses for off-screen faces (IntersectionObserver) and when nothing is mounted.
  Controls ~100ms; hover paints instantly, only the return eases; respect reduced motion.
- **OpenBot** (`lib/motion.ts`, `bot-orb.tsx`, MIT): one motion vocabulary file
  (`EASE_OUT = [0.23, 1, 0.32, 1]`, entrances 0.2s, "past ~250ms reads as thinking"). Small idle
  avatars are drawn still: twenty animated faces in a sidebar each cost a frame. A waiting bot idles.
  Nothing moves under reduced motion.

## States

| Mood | Ledger state | Motion | Timing | Extra | Label |
|---|---|---|---|---|---|
| idle | none open | Slow sway (turn ±1.5°, roll ±1.2°), blink | blink every 3.2s for 0.18s | Drawn still at ≤ 32px | – |
| ack | `received`, `dispatching` | One nod, eyes forward | 0.32s once, then hold | – | Starting |
| think | before tools run | Lean back, look up, three dots | Hermes `think` pose | – | Thinking |
| work | `running` | Lean in, sway, dots | Hermes `work` pose | No ring or spinner: the face is the signal (2026-11-28) | Working |
| needs_you | `waiting_input`, login/OTP/approval | Faces the person, no sway, one small hop | hop 2.5px for 0.36s every 4s | Red dot | Needs you |
| done | `completed` | Happy eyes | 1.2s, then back to idle | – | Done |
| error | `failed` | Still, eyes shut | none | Red label | Failed |

Transitions: every mood change blends over `MOOD_BLEND_SECONDS = 0.4` with ease-out. The dot
fade in/out over `ENTRANCE_SECONDS = 0.2` with `EASE_OUT`.

## Rules

1. Motion says the state; the label and glyph say it too. Never color or motion alone.
2. Never loop attention-seeking motion. `needs_you` hops once every 4s, it does not bounce.
3. One shared clock for every face, capped at 30fps (`FACE_CLOCK_FPS`), paused when the window
   is hidden or the face is off-screen.
4. Idle faces at ≤ 32px are still (`STATIC_IDLE_MAX_PX`). Working and needs-you faces animate at
   any size.
5. Reduced motion: no pose motion, no hop; the still `work` pose and the "Working" label carry the state. `reducedPose`
   keeps happy/shut eyes so done/error still read.
6. Hover over an avatar shows the current action in one line (Grok); click opens Overview.
7. Entrances 0.2s. Controls 100ms. Hover paints instantly; only the return eases.
8. No spinner where a face is shown (2026-11-28). A working face moves; that is the signal on web,
   desktop and mobile (rows, pinned tiles, rail, open chat). Grok Bot does the same (codex
   `049_goat-bot-uiux-catchup/130_grokbot_handson.md` §5, RM-03). Spinners stay only where no face
   is drawn (a person-started thread row: "Working 3m").
9. Faces must not peg the GPU (GOAT `AGENTS.md`: no continuously repainting animations). Only the
   open chat's face animates smoothly; list, tile and rail faces hold the `work` pose and step about
   once a second; off-screen faces pause.

## Open questions

- Custom avatars (Muse lets people make their own and renders them in every state): out of scope
  for v1; the shape + eyes system keeps every state drawable.
- Sound: none in v1.
