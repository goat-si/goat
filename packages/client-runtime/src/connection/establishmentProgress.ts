import type * as Queue from "effect/Queue";
import type { ConnectionSshPreparation } from "./model.ts";

export interface SetupPreparation {
  readonly routeId: string | undefined;
  readonly startedAt: bigint;
}

export interface EstablishmentProgress {
  readonly preparation: SetupPreparation;
  readonly pendingPreparations: ReadonlyMap<string, bigint>;
  readonly synchronizedRoutes: number;
  readonly hostAnswered: boolean;
  readonly setup: { readonly routeId: string; readonly elapsedMs: number } | null;
  readonly stage: "preparing" | "opening" | "synchronizing";
  readonly lastProgressAt: bigint;
  readonly synchronizedRouteIds: ReadonlySet<string>;
  readonly sshPreparation: {
    readonly operationId: string;
    readonly deadline: bigint;
    readonly phase: ConnectionSshPreparation["phase"];
    readonly hostAnswered: boolean;
  } | null;
  readonly wake: Queue.Queue<void>;
}
