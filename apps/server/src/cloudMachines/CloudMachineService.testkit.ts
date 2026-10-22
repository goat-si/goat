import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CloudMachineError,
  type BoatSandboxId,
  type CloudMachineAlias,
  type CloudMachineErrorReason,
  type CloudMachineState,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { BoatClient, type BoatSshEndpoint } from "./BoatClient.ts";
import * as CloudMachineService from "./CloudMachineService.ts";
import { CloudMachineSsh } from "./sshConfig.ts";

export const ID = "bx_23456789" as BoatSandboxId;
export const SECOND_ID = "bx_3456789a" as BoatSandboxId;
export const ALIAS = "boat-bx_23456789" as CloudMachineAlias;
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOv8eZbJtFiAHk3Fp2Kq";

/** A scripted Boat and SSH writer around the real CloudMachineService that record every call. */
export const makeWorld = () => {
  const states = new Map<string, CloudMachineState>();
  const milestones = { onGet: Effect.void as Effect.Effect<void> };
  const calls: Array<string> = [];
  const createKeys: Array<string> = [];
  const failures = new Map<string, CloudMachineErrorReason>();
  const missing = new Set<string>();
  const ids: Array<BoatSandboxId> = [ID, SECOND_ID];
  let endpoint: BoatSshEndpoint = {
    host: "203.0.113.10",
    port: 22,
    user: "user",
    hostKey: HOST_KEY,
  };
  let written: BoatSshEndpoint | null = null;
  const removedHosts: Array<string> = [];
  const invalidated: Array<string> = [];
  const secrets = new Map<string, Uint8Array>();
  const createdFor = new Map<string, BoatSandboxId>();

  const call = (name: string) =>
    Effect.suspend(() => {
      calls.push(name);
      const reason = failures.get(name);
      if (reason === undefined) return Effect.void;
      failures.delete(name);
      return Effect.fail(new CloudMachineError({ reason }));
    });
  const sandbox = (id: BoatSandboxId) => ({ id, name: null, state: states.get(id)! });

  const boat = BoatClient.of({
    checkKey: () => call("checkKey"),
    get: (_key, id) =>
      call("get").pipe(
        Effect.tap(() => milestones.onGet),
        Effect.flatMap(() =>
          missing.has(id)
            ? Effect.fail(new CloudMachineError({ reason: "not_found" }))
            : Effect.succeed(sandbox(id)),
        ),
      ),
    // Like Boat, a repeated Idempotency-Key returns the machine the first request made.
    create: (_key, _input, idempotencyKey) =>
      Effect.sync(() => {
        createKeys.push(idempotencyKey);
        let id = createdFor.get(idempotencyKey);
        if (id === undefined) {
          id = ids.shift()!;
          createdFor.set(idempotencyKey, id);
          states.set(id, "provisioning");
        }
        return id;
      }).pipe(Effect.flatMap((id) => call("create").pipe(Effect.as(sandbox(id))))),
    update: (_key, _id, patch) => call(`update:${JSON.stringify(patch)}`),
    stop: (_key, id) =>
      call("stop").pipe(Effect.tap(() => Effect.sync(() => states.set(id, "archiving")))),
    resume: (_key, id) =>
      call("resume").pipe(Effect.tap(() => Effect.sync(() => states.set(id, "ready")))),
    remove: () => call("remove"),
    authorizeSshKey: () => call("sshkey").pipe(Effect.map(() => endpoint)),
  });

  const ssh = CloudMachineSsh.of({
    installInclude: call("installInclude"),
    ensureKey: Effect.succeed({
      identityFile: "/home/.ssh/goat-cloud/id_ed25519",
      publicKey: "ssh-ed25519 AAAA",
    }),
    writeHost: (_alias, next) =>
      Effect.sync(() => {
        const changed =
          written === null ||
          written.host !== next.host ||
          written.port !== next.port ||
          written.user !== next.user ||
          written.hostKey !== next.hostKey;
        written = next;
        return { changed };
      }),
    removeHost: (alias) => Effect.sync(() => void removedHosts.push(alias)),
  });

  const secretStore = {
    get: (name: string) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
    set: (name: string, value: Uint8Array) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name: string) => Effect.sync(() => void secrets.delete(name)),
  } as unknown as ServerSecretStore.ServerSecretStore["Service"];

  return {
    states,
    milestones,
    calls,
    createKeys,
    failures,
    missing,
    removedHosts,
    invalidated,
    secrets,
    moveEndpoint: () => {
      endpoint = { ...endpoint, host: "198.51.100.7" };
    },
    layer: CloudMachineService.layerWithoutDependencies.pipe(
      Layer.provide(Layer.succeed(BoatClient, boat)),
      Layer.provide(Layer.succeed(CloudMachineSsh, ssh)),
      Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore)),
      Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-cloud-machines-test-" })),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(NodeServices.layer),
    ),
  };
};

export type World = ReturnType<typeof makeWorld>;
