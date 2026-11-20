import type { ServerSettings } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { withDisposableStamp } from "./hub/disposable/disposableSwitch.ts";
import { enforceMiniMaxCodeQuotaConsent } from "./provider/miniMaxCodeQuotaConsent.ts";

/** Run person-only transition checks on every committed settings write. */
export const withSettingsWriteConsent =
  <E, R>(update: (current: ServerSettings) => Effect.Effect<ServerSettings, E, R>) =>
  (current: ServerSettings) =>
    withDisposableStamp(update)(current).pipe(
      Effect.tap((next) => enforceMiniMaxCodeQuotaConsent(current, next)),
    );
