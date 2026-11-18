import { EnvironmentId, ProjectId, PullRequestOperationError, WS_METHODS } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  BearerConnectionProfile,
  PenConnectionProfile,
  SshConnectionProfile,
  type ConnectionRoute,
} from "../connection/catalog.ts";
import {
  BearerConnectionTarget,
  PenConnectionTarget,
  SshConnectionTarget,
} from "../connection/model.ts";
import * as ConnectionProfileStore from "../connection/profileStore.ts";
import { PullRequestRoutingPermissions } from "../connection/pullRequestRoutingPermissions.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { createPullRequestRouter } from "./pullRequestRouting.ts";
import { trustedRouting } from "./pullRequestRouting.testkit.ts";
import { makeTestRuntime, TARGET } from "./pullRequests.testkit.ts";

const identity = { host: "github.com", provider: "github", viewer: "maria", accountId: "123" };
const merge = {
  projectId: ProjectId.make("project-1"),
  repository: "acme/web",
  number: 7,
  action: "merge" as const,
};

// The closed viewer gate hides this stored route; it must not stand in for the route behind it.
function hiddenPen(environmentId: EnvironmentId): ConnectionRoute {
  const connectionId = "pen:mmmmmmmmmmmmmmmmmmmmmmmmmm:nnnnnnnnnnnnnnnnnnnnnnnnnn";
  return {
    target: new PenConnectionTarget({ environmentId, label: "Pen", connectionId }),
    profile: Option.some(
      new PenConnectionProfile({
        environmentId,
        label: "Pen",
        connectionId,
        meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
        nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
        noisePub: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
      }),
    ),
  };
}

// A refusing source falls through to the alternate, so a write there shows routing was allowed.
const clients = (calls: string[], sourceRefusesGuardedWrites: boolean) => {
  const clientFor = (local: boolean) => {
    const name = local ? "alternate" : "source";
    return {
      [local ? WS_METHODS.pullRequestsRoutingIdentity : WS_METHODS.pullRequestsRouting]: () =>
        Effect.succeed(identity),
      [WS_METHODS.pullRequestsRunAction]: (input: { expectedAccountId?: string }) =>
        Effect.gen(function* () {
          if (!local && sourceRefusesGuardedWrites && input.expectedAccountId !== undefined)
            return yield* new PullRequestOperationError({
              operation: "routeIdentity",
              detail: "Source guard refused.",
            });
          calls.push(`${name}-write`);
        }),
      [WS_METHODS.pullRequestsInvalidate]: () => Effect.void,
    } as unknown as WsRpcProtocolClient;
  };
  return [clientFor(false), clientFor(true)] as const;
};

it.effect.each(
  (["origin", "destination"] as const).flatMap((side) =>
    (["matching", "changed"] as const).map((stored) => ({ side, stored })),
  ),
)(
  "checks the current $side SSH profile behind a hidden Pen route with $stored storage",
  ({ side, stored }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const [source, alternate] = clients(calls, true);
        const { environmentRegistry, supervisor } = yield* makeTestRuntime(source, alternate);
        const environmentId =
          side === "origin" ? TARGET.environmentId : EnvironmentId.make("local-environment");
        const profile = new SshConnectionProfile({
          connectionId: "ssh-1",
          environmentId,
          label: "SSH",
          target: { alias: "work", hostname: "work.example.test", username: "maria", port: 22 },
        });
        const pen = hiddenPen(environmentId);
        yield* SubscriptionRef.update(environmentRegistry.entries, (entries) =>
          new Map(entries).set(environmentId, {
            target: pen.target,
            profile: pen.profile,
            alternateRoutes: [
              {
                target: new SshConnectionTarget({
                  environmentId,
                  connectionId: profile.connectionId,
                  label: "SSH",
                }),
                profile: Option.some(profile),
              },
            ],
            enabled: true,
          }),
        );
        const current =
          stored === "changed"
            ? new SshConnectionProfile({
                ...profile,
                target: { ...profile.target, hostname: "replacement.example.test" },
              })
            : profile;
        yield* createPullRequestRouter()(WS_METHODS.pullRequestsRunAction, merge).pipe(
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(PullRequestRoutingPermissions, trustedRouting),
          Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
          Effect.provideService(ConnectionProfileStore.ConnectionProfileStore, {
            get: (connectionId) =>
              Effect.succeed(
                connectionId === profile.connectionId ? Option.some(current) : Option.none(),
              ),
            put: () => Effect.die("unused"),
            remove: () => Effect.die("unused"),
          }),
        );
        expect(calls).toEqual(stored === "matching" ? ["alternate-write"] : ["source-write"]);
      }),
    ),
);

it.effect(
  "keeps a write on a local origin whose loopback route sits behind a hidden Pen route",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const [source, alternate] = clients(calls, false);
        const { environmentRegistry, supervisor } = yield* makeTestRuntime(source, alternate);
        const environmentId = TARGET.environmentId;
        const pen = hiddenPen(environmentId);
        yield* SubscriptionRef.update(environmentRegistry.entries, (entries) =>
          new Map(entries).set(environmentId, {
            target: pen.target,
            profile: pen.profile,
            alternateRoutes: [
              {
                target: new BearerConnectionTarget({
                  environmentId,
                  label: "This Mac",
                  connectionId: "b-1",
                }),
                profile: Option.some(
                  new BearerConnectionProfile({
                    environmentId,
                    label: "This Mac",
                    connectionId: "b-1",
                    httpBaseUrl: "http://127.0.0.1:3774",
                    wsBaseUrl: "ws://127.0.0.1:3774",
                  }),
                ),
              },
            ],
            enabled: true,
          }),
        );
        yield* createPullRequestRouter()(WS_METHODS.pullRequestsRunAction, merge).pipe(
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(PullRequestRoutingPermissions, trustedRouting),
          Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
        );
        expect(calls).toEqual(["source-write"]);
      }),
    ),
);
