import * as Schema from "effect/Schema";
const SafeCounter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const BackendGeneration = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,96}$/));
export const ManagedWatchdogBootstrap = Schema.Union([
  Schema.Struct({
    protocol: Schema.Literal(1),
    generation: BackendGeneration,
    mode: Schema.Literal("fd"),
    healthFd: Schema.Int.check(Schema.isBetween({ minimum: 3, maximum: 64 })),
  }),
  Schema.Struct({
    protocol: Schema.Literal(1),
    generation: BackendGeneration,
    mode: Schema.Literal("self-observer"),
  }),
]);
export type ManagedWatchdogBootstrap = typeof ManagedWatchdogBootstrap.Type;
export const DesktopBackendHealth = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("backendHealth"),
  generation: BackendGeneration,
  observerSequence: SafeCounter.check(Schema.isGreaterThan(0)),
  mainSequence: SafeCounter,
  phase: Schema.Literals(["starting", "migrating", "recovering", "ready", "stopping"]),
  verdict: Schema.Literals(["healthy", "main-silent"]),
});
export type DesktopBackendHealth = typeof DesktopBackendHealth.Type;
