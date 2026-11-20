import { EnvironmentId } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PenConnectionProfile, PenConnectionRegistration } from "../connection/catalog.ts";
import { BearerConnectionTarget, PenConnectionTarget } from "../connection/model.ts";
import {
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
  registerThroughCatalog,
  removeConnectionFromCatalog,
  setConnectionEnabledInCatalog,
  setRoutesInCatalog,
  type ConnectionCatalogDocument,
} from "./storageDocument.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Bearer",
  connectionId: "bearer-1",
});

it("an environment saved with only routes the closed Pen gate hides comes back last and switched on, as a new one does", () => {
  const other = (name: string) =>
    new BearerConnectionTarget({
      environmentId: EnvironmentId.make(name),
      label: name,
      connectionId: name,
    });
  const pen = new PenConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Pen",
    connectionId: "pen:mmmmmmmmmmmmmmmmmmmmmmmmmm:nnnnnnnnnnnnnnnnnnnnnnnnnn",
  });
  const document = {
    ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
    targets: [other("b"), pen, other("c")],
    // An older build switched the Pen-only environment off.
    disabledEnvironmentIds: [ENVIRONMENT_ID],
  };
  const next = setRoutesInCatalog(document, ENVIRONMENT_ID, [pen, BEARER_TARGET]);
  expect(next.disabledEnvironmentIds).toEqual([]);
  expect(next.targets.map((target) => target.environmentId)).toEqual([
    "b",
    "c",
    ENVIRONMENT_ID,
    ENVIRONMENT_ID,
  ]);
});

it("rewriting an environment's routes keeps the Pen routes the closed gate hides, which another channel may have saved", () => {
  const pen = new PenConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Pen",
    connectionId: "pen:mmmmmmmmmmmmmmmmmmmmmmmmmm:nnnnnnnnnnnnnnnnnnnnnnnnnn",
  });
  const document = { ...EMPTY_CONNECTION_CATALOG_DOCUMENT, targets: [pen, BEARER_TARGET] };
  expect(setRoutesInCatalog(document, ENVIRONMENT_ID, [BEARER_TARGET]).targets).toEqual([
    pen,
    BEARER_TARGET,
  ]);
  expect(
    removeConnectionFromCatalog(document, ENVIRONMENT_ID, { keepHidden: true }).targets,
  ).toEqual([pen]);
  // Removing the environment itself takes its Pen routes with it.
  expect(removeConnectionFromCatalog(document, ENVIRONMENT_ID).targets).toEqual([]);
});

it("a Pen member's route stays with the environment that saved it when another one registers it", () => {
  const connectionId = "pen:mmmmmmmmmmmmmmmmmmmmmmmmmm:nnnnnnnnnnnnnnnnnnnnnnnnnn";
  const pin = {
    meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
    nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
    noisePub: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
  };
  const saved = new PenConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Box",
    connectionId,
  });
  const document = {
    ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
    targets: [saved],
    profiles: [
      new PenConnectionProfile({
        ...pin,
        environmentId: ENVIRONMENT_ID,
        label: "Box",
        connectionId,
      }),
    ],
  };
  const other = EnvironmentId.make("answered-as-another");
  const next = registerConnectionInCatalog(
    document,
    new PenConnectionRegistration({
      target: new PenConnectionTarget({ environmentId: other, label: "Box", connectionId }),
      profile: new PenConnectionProfile({
        ...pin,
        environmentId: other,
        label: "Box",
        connectionId,
      }),
    }),
  );
  expect(next).toBe(document);
});

const penOnly = (): ConnectionCatalogDocument => ({
  ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
  targets: [
    new PenConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Pen",
      connectionId: "pen:mmmmmmmmmmmmmmmmmmmmmmmmmm:nnnnnnnnnnnnnnnnnnnnnnnnnn",
    }),
  ],
});

it("switching off an environment that holds only Pen routes the closed gate hides saves no off switch, as for a removed one", () => {
  expect(
    setConnectionEnabledInCatalog(penOnly(), ENVIRONMENT_ID, false).disabledEnvironmentIds,
  ).toEqual([]);
});

it.effect("a registration through the catalog tells whether the newest catalog took it", () =>
  Effect.gen(function* () {
    const connectionId = "pen:mmmmmmmmmmmmmmmmmmmmmmmmmm:nnnnnnnnnnnnnnnnnnnnnnnnnn";
    const pin = {
      meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
      nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
      noisePub: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    };
    let document = penOnly();
    const update = (transform: (current: ConnectionCatalogDocument) => ConnectionCatalogDocument) =>
      Effect.sync(() => void (document = transform(document)));
    const as = (environmentId: EnvironmentId) =>
      new PenConnectionRegistration({
        target: new PenConnectionTarget({ environmentId, label: "Box", connectionId }),
        profile: new PenConnectionProfile({ ...pin, environmentId, label: "Box", connectionId }),
      });
    expect(yield* registerThroughCatalog(update, as(EnvironmentId.make("another")), [])).toBe(
      false,
    );
    expect(yield* registerThroughCatalog(update, as(ENVIRONMENT_ID), [])).toBe(true);
  }),
);
