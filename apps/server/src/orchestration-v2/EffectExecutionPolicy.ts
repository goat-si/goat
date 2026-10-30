import type { OrchestrationEffectRequestV2 } from "./EffectOutbox.ts";

export type EffectLane = "general" | "control" | "cleanup";

export const EFFECT_LANES = {
  "provider-runtime.continue": "general",
  "provider-session.detach": "control",
  "provider-turn.reattach": "general",
  "provider-turn.start": "general",
  "provider-turn.interrupt": "control",
  "provider-turn.steer": "general",
  "provider-turn.restart": "general",
  "runtime-request.respond": "control",
  "provider-thread.rollback": "general",
  "checkpoint.capture": "general",
  "scheduled-tasks.cleanup": "cleanup",
  "terminal.cleanup": "cleanup",
  "preview.cleanup": "cleanup",
  "attachment.cleanup": "cleanup",
  "thread-title.generate": "general",
  "delegated-tasks.stop": "control",
  "computer-use.stop": "control",
} as const satisfies Record<OrchestrationEffectRequestV2["type"], EffectLane>;

export const effectTypesForLane = (lane: EffectLane) =>
  (Object.keys(EFFECT_LANES) as Array<OrchestrationEffectRequestV2["type"]>).filter(
    (kind) => EFFECT_LANES[kind] === lane,
  );
