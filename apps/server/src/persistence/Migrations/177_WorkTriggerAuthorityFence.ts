import * as Effect from "effect/Effect";
import {
  fenceWorkTriggerRollback,
  hasPersistedWorkTriggers,
} from "../reconcileGoatMigrationIds.ts";

export default Effect.gen(function* () {
  if (yield* hasPersistedWorkTriggers) yield* fenceWorkTriggerRollback();
});
