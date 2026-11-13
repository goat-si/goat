import { expect, it } from "@effect/vitest";
import { presentFleetConnection } from "./fleetConnection.ts";

it("explains why a Pen environment is held", () => {
  expect(
    presentFleetConnection({ phase: "available", error: null, penHold: "offline" }).label,
  ).toBe("Offline in Pen");
  expect(
    presentFleetConnection({ phase: "available", error: null, penHold: "waiting" }),
  ).toMatchObject({
    label: "Not open",
    reason: "This computer keeps 16 Pen machines open at a time.",
  });
});
