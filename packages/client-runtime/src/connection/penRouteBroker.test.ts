import { describe, expect, it } from "@effect/vitest";
import { penPinIsCurrent } from "./penRouteBroker.ts";

describe("Pen native membership", () => {
  const pin = { meshId: "mesh", nodeId: "node", noisePub: "key" };
  const ready = {
    kind: "ready" as const,
    seq: 1,
    meshId: "mesh",
    selfNodeId: "self",
    members: [
      {
        nodeId: "node",
        name: "Node",
        online: true,
        noisePub: "key",
        route: { kind: "refused" as const, reason: "not-pen-route" as const },
      },
    ],
  };
  it("admits a listed pin independently of its SSH refusal", () => {
    expect(penPinIsCurrent(ready, pin)).toBe(true);
  });
  it("rejects a departed or rotated pin and self", () => {
    expect(penPinIsCurrent({ ...ready, members: [] }, pin)).toBe(false);
    expect(penPinIsCurrent(ready, { ...pin, noisePub: "rotated" })).toBe(false);
    expect(penPinIsCurrent({ ...ready, selfNodeId: "node" }, pin)).toBe(false);
    expect(penPinIsCurrent({ kind: "unavailable", seq: 2, reason: "stale" }, pin)).toBe(false);
  });
});

import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  PenRouteGateway,
  PenViewerPolicy,
  ClientPresentation,
  type PenMembersInput,
} from "../platform/capabilities.ts";
import { PenConnectionProfile } from "./catalog.ts";
import { PenConnectionTarget, penConnectionId } from "./model.ts";
import { PenMembership } from "./penMembership.ts";
import { makePenRouteBroker } from "./penRouteBroker.ts";

it.effect(
  "never opens a persisted Pen route with the gate off, no gateway, or stale membership",
  () =>
    Effect.gen(function* () {
      let opens = 0;
      const environmentId = EnvironmentId.make("environment");
      const pin = { meshId: "mesh", nodeId: "node", noisePub: "key" };
      const connectionId = penConnectionId(pin.meshId, pin.nodeId);
      const target = new PenConnectionTarget({ environmentId, connectionId, label: "Node" });
      const entry = {
        target,
        enabled: true,
        profile: Option.some(
          new PenConnectionProfile({ ...pin, environmentId, connectionId, label: "Node" }),
        ),
      };
      const latest = yield* SubscriptionRef.make<Option.Option<PenMembersInput>>(
        Option.some({
          kind: "ready",
          seq: 1,
          meshId: "mesh",
          selfNodeId: "self",
          members: [
            {
              nodeId: "node",
              name: "Node",
              online: true,
              noisePub: "key",
              route: { kind: "refused", reason: "not-pen-route" },
            },
          ],
        }),
      );
      const gateway = Option.some({
        open: () => {
          opens++;
          return Effect.succeed({ kind: "refused" as const, reason: "busy" as const });
        },
        close: () => Effect.void,
      });
      const client = HttpClient.make(() => Effect.die("unexpected HTTP"));
      for (const [enabled, currentGateway, stale] of [
        [false, gateway, false],
        [true, Option.none(), false],
        [true, gateway, true],
      ] as const) {
        if (stale)
          yield* SubscriptionRef.set(
            latest,
            Option.some({ kind: "unavailable", seq: 2, reason: "stale" }),
          );
        const result = yield* Effect.gen(function* () {
          const broker = yield* makePenRouteBroker();
          return yield* broker(entry);
        }).pipe(
          Effect.provideService(PenMembership, { latest, admit: () => Effect.void }),
          Effect.provideService(PenViewerPolicy, { enabled }),
          Effect.provideService(PenRouteGateway, currentGateway),
          Effect.provideService(ClientPresentation, { metadata: { surface: "desktop" } }),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
      }
      expect(opens).toBe(0);
    }),
);

it.effect("refuses a different environment behind a listed member", () =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("expected");
    const pin = { meshId: "mesh", nodeId: "node", noisePub: "key" };
    const connectionId = penConnectionId(pin.meshId, pin.nodeId);
    const entry = {
      enabled: true,
      target: new PenConnectionTarget({ environmentId, connectionId, label: "Node" }),
      profile: Option.some(
        new PenConnectionProfile({ ...pin, environmentId, connectionId, label: "Node" }),
      ),
    };
    const latest = yield* SubscriptionRef.make<Option.Option<PenMembersInput>>(
      Option.some({
        kind: "ready",
        seq: 1,
        meshId: "mesh",
        selfNodeId: "self",
        members: [
          {
            nodeId: "node",
            name: "Node",
            online: true,
            noisePub: "key",
            route: { kind: "refused", reason: "not-pen-route" },
          },
        ],
      }),
    );
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            environmentId: "other",
            label: "Node",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "1.0.0",
            capabilities: { repositoryIdentity: true },
          }),
        ),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const broker = yield* makePenRouteBroker();
      return yield* broker(entry);
    }).pipe(
      Effect.provideService(PenMembership, { latest, admit: () => Effect.void }),
      Effect.provideService(PenViewerPolicy, { enabled: true }),
      Effect.provideService(
        PenRouteGateway,
        Option.some({
          open: () =>
            Effect.succeed({
              kind: "open",
              httpBaseUrl: `http://127.0.0.1/pen-route/${"a".repeat(43)}`,
              socketUrl: `ws://127.0.0.1/pen-route/${"a".repeat(43)}/ws`,
            }),
          close: () => Effect.void,
        }),
      ),
      Effect.provideService(ClientPresentation, { metadata: { surface: "desktop" } }),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.detail).toContain("does not match");
  }),
);
