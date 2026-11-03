import { it } from "@effect/vitest";
import { recoveryScenario } from "./ProviderRuntimeRecoverySurvivor.testkit.ts";

it.effect("mixed survivor and unrelated work reconciles without destroying shared state", () =>
  recoveryScenario("restart", false, "completed", true),
);
it.effect.each(["completed", "failed", "interrupted"] as const)(
  "terminal salted turn settles the active run once with no continuation (%s)",
  (terminalStatus) => recoveryScenario("restart", false, terminalStatus),
);
it.effect.each([
  ["off", false],
  ["off", true],
  ["restart", false],
  ["restart", true],
  ["always", false],
  ["always", true],
] as const)("survival is independent of continuation setting (%s, %s)", ([survival, ordinary]) =>
  recoveryScenario(survival, ordinary),
);
it.effect.each([
  "ordinary",
  "ordinary-record",
  "gone",
  "unknown",
  "unknown-native",
  "missing",
  "preserve-failure",
  "stopped",
  "stop-completed",
  "unreadable",
  "stop-clear-crash",
  "goal-release",
  "goal-held",
] as const)("startup handles Codex recovery case %s without blocking other threads", (reviewCase) =>
  recoveryScenario("restart", false, "completed", false, reviewCase),
);
it.effect("verified loss never continues when ordinary continuation is enabled", () =>
  recoveryScenario("restart", true, "completed", false, "gone"),
);

it.effect(
  "a paused goal remains fenced across a second startup before native turns are scanned",
  () => recoveryScenario("restart", false, "completed", false, "goal-release"),
);

it.effect(
  "queued Codex starts on a shared instance do not block recovery or a same-thread survivor",
  () => recoveryScenario("restart", false, "completed", true),
);
