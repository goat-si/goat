import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  ComputerUseHistoryInput,
  ComputerUseHistoryResult,
  ComputerUseHistoryError,
} from "./computerUseHistory.ts";

export const WsComputerUseHistoryRpc = Rpc.make("computerUse.history", {
  payload: ComputerUseHistoryInput,
  success: ComputerUseHistoryResult,
  error: Schema.Union([ComputerUseHistoryError, EnvironmentAuthorizationError]),
});

export const WsComputerUseStatusChangesRpc = Rpc.make("computerUse.statusChanges", {
  payload: Schema.Struct({}),
  success: Schema.Struct({ revision: NonNegativeInt }),
  error: EnvironmentAuthorizationError,
  stream: true,
});

/**
 * The apps running on this host that computer use could reach, with names and icons, for the
 * composer's @ list and the icons beside an agent's calls. Empty when computer use is off or the
 * host cannot list them; asking grants nothing.
 */
