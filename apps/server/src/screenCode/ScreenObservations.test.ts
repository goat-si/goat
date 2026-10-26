import { expect, it } from "@effect/vitest";
import { ScreenObservations } from "./ScreenObservations.ts";

it("a new desktop observation invalidates the previous element reference", () => {
  const observations = new ScreenObservations();
  const draft = {
    targetRef: {
      id: "target",
      kind: "app" as const,
      environmentId: "env",
      runId: "run",
      turnId: "turn",
      generation: 1,
    },
    targetGeneration: 1,
    surfaceGeneration: 2,
    indexedText: "Save",
    complete: true,
    truncated: false,
    loading: false,
    elements: [{ role: "button", name: "Save", driverToken: "private-driver-token" }],
  };
  const first = observations.renderObservation({
    draft,
    mode: "full",
    limits: { treeBytes: 1024 },
  });
  const ref = first.elements[0]?.ref;
  expect(ref && observations.index.resolveElement(ref)).toBe("private-driver-token");
  const second = observations.renderObservation({
    draft,
    mode: "full",
    limits: { treeBytes: 1024 },
  });
  expect(ref && observations.index.resolveElement(ref)).toBeUndefined();
  expect(second.elements[0]?.ref.id).not.toBe(ref?.id);
  expect(JSON.stringify(second)).not.toContain("private-driver-token");
  expect(
    observations.index.putRegion("target", second.observationId, "region", {
      x: 0,
      y: 0,
      width: 20,
      height: 20,
    }),
  ).toBe(true);
  expect(
    observations.index.resolvePoint({
      observationId: second.observationId,
      regionId: "region",
      x: 5,
      y: 5,
    }),
  ).toEqual({ targetId: "target", x: 5, y: 5 });
  expect(
    observations.index.resolvePoint({
      observationId: first.observationId,
      regionId: "region",
      x: 5,
      y: 5,
    }),
  ).toBeUndefined();
});
