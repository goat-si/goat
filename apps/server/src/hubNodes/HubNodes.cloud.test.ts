import { expect, it } from "@effect/vitest";
import { EnvironmentId, ExecutionEnvironmentDescriptor } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";

import * as CloudMachineService from "../cloudMachines/CloudMachineService.ts";
import { ALIAS, ID, makeWorld } from "../cloudMachines/CloudMachineService.testkit.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as LinkedHosts from "../linkedHosts/LinkedHosts.ts";
import migration from "../persistence/Migrations/094_HubNodes.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as HubNodeRepository from "./HubNodeRepository.ts";
import * as HubNodes from "./HubNodes.ts";

const hub = EnvironmentId.make("env-hub");
const remote = EnvironmentId.make("env-cloud-box");
const descriptor = Schema.decodeSync(ExecutionEnvironmentDescriptor)({
  environmentId: hub,
  label: "Hub",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "test",
  capabilities: { repositoryIdentity: true },
});
const unused = () => Effect.die("not used by a hub check");

it.effect("learns a running cloud machine's identity on the check that prepares its SSH", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    yield* Effect.gen(function* () {
      const cloud = yield* CloudMachineService.CloudMachineService;
      yield* cloud.configure({ apiKey: "boat_test_key", consentToSshInclude: true });
      yield* cloud.create({ label: "Build box", type: "small", ttlSeconds: 3600 });
      world.states.set(ID, "running");
      world.calls.length = 0;
      yield* migration;
      const repository = yield* HubNodeRepository.HubNodeRepository.pipe(
        Effect.provide(HubNodeRepository.layer),
      );
      // Like SshRemoteDispatch, identifying an owned alias first refreshes its endpoint quietly.
      const ssh = SshRemoteDispatch.SshRemoteDispatch.of({
        identifyTarget: (target: { readonly alias: string }) =>
          cloud
            .ensureReady(target.alias as typeof ALIAS, { wake: false })
            .pipe(Effect.as(remote), Effect.orDie),
      } as unknown as SshRemoteDispatch.SshRemoteDispatch["Service"]);
      const service = yield* HubNodes.make.pipe(
        Effect.provideService(HubNodeRepository.HubNodeRepository, repository),
        Effect.provideService(
          LinkedHosts.LinkedHosts,
          LinkedHosts.LinkedHosts.of({
            changes: Stream.never,
            list: Effect.succeed([]),
            names: Effect.succeed([]),
            find: () => Effect.succeedNone,
            link: unused,
            unlink: unused,
          }),
        ),
        Effect.provideService(SshRemoteDispatch.SshRemoteDispatch, ssh),
        Effect.provideService(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(hub),
          getDescriptor: Effect.succeed(descriptor),
        }),
        Effect.provideService(HttpClient.HttpClient, HttpClient.make(unused)),
      );

      const checked = yield* service.check({});
      expect(world.calls).toContain("sshkey");
      expect(checked.nodes).toHaveLength(1);
      expect(checked.nodes[0]).toMatchObject({
        nodeId: remote,
        environmentId: remote,
        status: "online",
      });
      expect(world.calls.some((name) => name === "resume" || name.startsWith("update:"))).toBe(
        false,
      );
    }).pipe(Effect.provide(world.layer));
  }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
