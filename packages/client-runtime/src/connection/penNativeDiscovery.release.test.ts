import { EnvironmentId } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  PenRouteGateway,
  PenViewerPolicy,
  type PenMembersInput,
} from "../platform/capabilities.ts";
import { PenConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import { PenConnectionTarget, penConnectionId } from "./model.ts";
import { PenMembership } from "./penMembership.ts";
import { makePenNativeDiscovery } from "./penNativeDiscovery.ts";
import { EnvironmentRegistry } from "./registry.ts";

it.effect(
  "removing the environment that holds a member's route closes the member's gateway link",
  () =>
    Effect.gen(function* () {
      const env = EnvironmentId.make("env");
      const pin = {
        meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
        nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
        noisePub: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
      };
      const id = penConnectionId(pin.meshId, pin.nodeId);
      const target = new PenConnectionTarget({
        environmentId: env,
        label: "Node",
        connectionId: id,
      });
      const profile = new PenConnectionProfile({
        ...pin,
        environmentId: env,
        label: "Node",
        connectionId: id,
      });
      const saved = new Map([[env, { enabled: true, target, profile: Option.some(profile) }]]);
      const entries =
        yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(saved);
      const ready = {
        kind: "ready" as const,
        seq: 1,
        meshId: pin.meshId,
        selfNodeId: "self",
        members: [
          {
            nodeId: pin.nodeId,
            name: "Node",
            online: true,
            noisePub: pin.noisePub,
            route: { kind: "refused" as const, reason: "not-pen-route" as const },
          },
        ],
      };
      const latest = yield* SubscriptionRef.make<Option.Option<PenMembersInput>>(
        Option.some(ready),
      );
      const closed: string[] = [];
      const unused = () => Effect.die("unexpected registry call");
      const unusedStream = () => Stream.die("unexpected registry stream");
      const registry = EnvironmentRegistry.of({
        entries,
        networkStatus: yield* SubscriptionRef.make<"unknown" | "online" | "offline">("online"),
        start: Effect.void,
        register: unused,
        registerPlatform: unused,
        assertKnownAddress: unused,
        reconcilePlatform: unused,
        remove: unused,
        removeRoute: unused,
        reorderRoutes: unused,
        removeRelayEnvironments: unused,
        retryNow: unused,
        reconnect: unused,
        setEnabled: unused,
        setCompatibility: unused,
        state: unused,
        stateChanges: unusedStream,
        run: unused,
        runStream: unusedStream,
        followStream: unusedStream,
      });
      yield* Effect.gen(function* () {
        const discovery = yield* makePenNativeDiscovery();
        yield* discovery.release(saved);
        yield* discovery.pass(ready);
        expect(closed).toEqual([]);
        yield* discovery.release(new Map());
        expect(closed).toEqual([pin.nodeId]);
      }).pipe(
        Effect.provideService(EnvironmentRegistry, registry),
        Effect.provideService(PenMembership, { latest, admit: () => Effect.void }),
        Effect.provideService(PenViewerPolicy, { enabled: true }),
        Effect.provideService(
          PenRouteGateway,
          Option.some({
            open: () =>
              Effect.succeed({
                kind: "open" as const,
                httpBaseUrl: `http://127.0.0.1/pen-route/${"a".repeat(43)}`,
                socketUrl: "ws://127.0.0.1/ws",
              }),
            close: (closing) => Effect.sync(() => void closed.push(closing.nodeId)),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  environmentId: "env",
                  label: "Node",
                  platform: { os: "darwin", arch: "arm64" },
                  serverVersion: "1.0.0",
                  capabilities: { repositoryIdentity: true },
                }),
              ),
            ),
          ),
        ),
      );
    }),
);
