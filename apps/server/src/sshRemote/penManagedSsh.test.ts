import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import * as SshAuth from "@goat/ssh/auth";
import * as SshTunnel from "@goat/ssh/tunnel";
import { SshInvalidTargetError } from "@goat/ssh/errors";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type { PenManagedRoutesShape } from "../hubNodes/PenManagedRoutes.ts";
import { guardPenManaged } from "./penManagedSsh.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- source boundary test reads the repository tree.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- source boundary test resolves repository paths.
import * as NodePath from "node:path";

const target = { alias: "pen-member", hostname: "pen-member", username: null, port: null };
const testServices = Layer.mergeAll(
  NodeServices.layer,
  NetService.layer,
  SshAuth.SshPasswordPrompt.disabledLayer,
  FetchHttpClient.layer,
);

const fixture = () => {
  const calls: Array<{ method: string; options: unknown }> = [];
  const state = { managed: true, admitted: true };
  const unused = () => Effect.die("unexpected manager call");
  const manager = SshTunnel.SshEnvironmentManager.of({
    status: unused,
    readyEnvironment: unused,
    beginSetupOperation: unused,
    publishSetupOutcome: unused,
    publishProviderDiagnosis: unused,
    forgetEnvironment: unused,
    disconnectEnvironment: () => Effect.void,
    revalidateTunnels: () => Effect.void,
    runRemoteScript: unused,
    ensureEnvironment: (_target, options) => {
      calls.push({ method: "ensure", options });
      return Effect.succeed({
        target,
        httpBaseUrl: "http://example",
        wsBaseUrl: "ws://example",
        pairingToken: null,
      });
    },
    issueClientSession: (_target, options) => {
      calls.push({ method: "client", options });
      return Effect.succeed({ token: "test", expiresAt: null, scopes: options.scopes });
    },
    issueMcpClientSession: (_target, options) => {
      calls.push({ method: "mcp", options });
      return Effect.succeed({ token: "test", expiresAt: null, runtimeModeCeilingApplied: true });
    },
  });
  const routes: PenManagedRoutesShape = {
    isManaged: () => state.managed,
    binding: () => undefined,
    admit: () =>
      state.admitted
        ? Effect.succeed({ selfNodeId: "local" })
        : Effect.fail(new SshInvalidTargetError({ message: "refused" })),
    hold: () => Effect.void,
    release: () => Effect.void,
    registerCleanup: () => Effect.void,
  };
  return { guarded: guardPenManaged(manager, routes), calls, state };
};

describe("guardPenManaged", () => {
  it("keeps production SSH manager acquisition at one boundary", () => {
    const root = NodePath.join(import.meta.dirname, "..");
    const sources = (directory: string): string[] =>
      NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = NodePath.join(directory, entry.name);
        if (entry.isDirectory()) return entry.name === "testkit" ? [] : sources(path);
        return entry.name.endsWith(".ts") &&
          !entry.name.includes(".test.") &&
          !entry.name.includes(".testkit.")
          ? [path]
          : [];
      });
    const occurrences = sources(root).flatMap((path) => {
      const text = NodeFS.readFileSync(path, "utf8");
      return [...text.matchAll(/yield\*\s+SshTunnel\.SshEnvironmentManager\b/gu)].map(() => path);
    });
    expect(occurrences).toEqual([NodePath.join(root, "sshRemote", "SshRemoteDispatch.ts")]);
  });
  it.effect("uses existing runtimes and member issuance only after admission", () =>
    Effect.gen(function* () {
      const { guarded, calls } = fixture();
      yield* guarded.ensureEnvironment(target);
      yield* guarded.issueClientSession(target, {
        subject: "ordinary",
        label: "hub",
        ttl: "1h",
        scopes: [],
      });
      yield* guarded.issueMcpClientSession(target, {
        label: "mcp",
        ttl: "1h",
        runtimeModeCeiling: null,
      });
      expect(calls).toEqual([
        { method: "ensure", options: { installation: "existing-only" } },
        {
          method: "client",
          options: {
            penMember: "local",
            label: "hub",
            ttl: "1h",
            scopes: [],
            installation: "existing-only",
          },
        },
        {
          method: "mcp",
          options: {
            label: "mcp",
            ttl: "1h",
            runtimeModeCeiling: null,
            installation: "existing-only",
          },
        },
      ]);
    }).pipe(Effect.provide(testServices)),
  );

  it.effect("refuses setup, replacement and failed admission without reaching the manager", () =>
    Effect.gen(function* () {
      const { guarded, calls, state } = fixture();
      for (const options of [
        { refreshRuntime: true },
        { confirmReplacement: true },
        { forceReplace: { pid: 1, port: 1234, startedAt: "start" } },
      ]) {
        const result = yield* Effect.flip(guarded.ensureEnvironment(target, options));
        expect(result).toMatchObject({
          _tag: "SshLaunchError",
          reason: "existing-runtime-required",
        });
      }
      const setup = yield* Effect.flip(guarded.beginSetupOperation(target, "operation"));
      expect(setup).toMatchObject({ _tag: "SshLaunchError", reason: "existing-runtime-required" });
      state.admitted = false;
      const rejected = yield* Effect.flip(guarded.ensureEnvironment(target));
      expect(rejected._tag).toBe("SshInvalidTargetError");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(testServices)),
  );

  it.effect("leaves ordinary aliases and optional manager methods alone", () =>
    Effect.gen(function* () {
      const { guarded, calls, state } = fixture();
      state.managed = false;
      yield* guarded.ensureEnvironment(target, { refreshRuntime: true });
      yield* guarded.issueClientSession(target, {
        subject: "ordinary",
        label: "hub",
        ttl: "1h",
        scopes: [],
      });
      expect(calls[0]?.options).toEqual({ refreshRuntime: true });
      expect(calls[1]?.options).toEqual({
        subject: "ordinary",
        label: "hub",
        ttl: "1h",
        scopes: [],
      });
      expect(guarded.attachedServerKind).toBeUndefined();
    }).pipe(Effect.provide(testServices)),
  );
});
