/**
 * GOAT 2 motion vocabulary, in one place (see docs/MOTION.md).
 *
 * EASE_OUT and ENTRANCE_SECONDS are lifted from CopilotKit/OpenBot app/src/lib/motion.ts (MIT):
 * "anything past ~250ms starts reading as the interface thinking rather than responding."
 * CONTROL_MS and the instant-hover rule come from NousResearch/hermes-agent apps/desktop/DESIGN.md (MIT).
 * MOOD_BLEND_SECONDS comes from hermes-agent hermes-bots/avatar.tsx settlePose (0.4s, ease-out quad).
 */

/** Strong ease-out for entrances and state changes. */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
export const EASE_OUT_CSS = "cubic-bezier(0.23, 1, 0.32, 1)";

/** How long something takes to arrive. */
export const ENTRANCE_SECONDS = 0.2;

/** Controls: quick, functional. Hover paints instantly; only the return eases. */
export const CONTROL_MS = 100;

/** A face blends from its last painted pose to the new mood's pose over this time. */
export const MOOD_BLEND_SECONDS = 0.4;

/** One full turn of the working ring around the provider chip. */
export const WORKING_RING_SECONDS = 1.2;

/** Faces at or below this size are drawn still while idle (OpenBot BotOrb STATIC_MAX_SIZE idea). */
export const STATIC_IDLE_MAX_PX = 32;

/** Frame budget for the shared face clock. */
export const FACE_CLOCK_FPS = 30;
