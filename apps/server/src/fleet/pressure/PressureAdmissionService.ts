import type {
  GoatHostStatusResult,
  HostPressure,
  HostPressureAdvice,
  HostStatusEntry,
} from "@goat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * The cached pressure admission service, apart from the nudger so launch and watch code can ask
 * for it without importing the host-status and MCP graph the nudger depends on.
 */
export interface PressureAdmission {
  readonly advice: HostPressureAdvice | undefined;
  /** fleet.pressure.admission is "block" and the host is critical. */
  readonly refuse: boolean;
}

/** Shared cached admission state; construction does not depend on watches or host-status reads. */
export class PressureAdmissionService extends Context.Service<
  PressureAdmissionService,
  {
    /** Records each host's pressure from a goat_host_status answer. */
    readonly observe: (result: GoatHostStatusResult) => Effect.Effect<void>;
    /** What a launch onto this host should be told, from readings this machine already has. */
    readonly admit: (host: string | null) => Effect.Effect<PressureAdmission>;
    readonly pressureOf: (host: string | null) => Effect.Effect<HostPressure | undefined>;
    readonly freshEntries: Effect.Effect<ReadonlyArray<HostStatusEntry>>;
  }
>()("goat/fleet/pressure/PressureAdmissionService") {}
