import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { prepareSettlementRegression } from "./testkit/SshHostPrepareFixture.ts";

it.effect.each(["before", "after", "publication", "interrupted"] as const)(
  "settles prepare on unexpected exit (%s)",
  (mode) => prepareSettlementRegression(mode).pipe(Effect.scoped),
);
