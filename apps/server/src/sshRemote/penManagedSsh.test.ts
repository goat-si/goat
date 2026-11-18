import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import * as SshAuth from "@goat/ssh/auth";
import * as SshTunnel from "@goat/ssh/tunnel";
import { SshInvalidTargetError } from "@goat/ssh/errors";
import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expectingPen, type PenManagedRoutesShape } from "../hubNodes/PenManagedRoutes.ts";
import { guardPenManaged } from "./penManagedSsh.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- source boundary test reads the repository tree.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- source boundary test resolves repository paths.
import * as NodePath from "node:path";

const target = { alias: "pen-member", hostname: "pen-member", username: null, port: null };
const binding = { meshId: "m".repeat(26), nodeId: "a".repeat(26), noisePub: "a".repeat(43) };
const testServices = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
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
    closeAllTunnels: Effect.void,
    forgetEnvironment: (_target, options) => {
      calls.push({ method: "forget", options });
      return Effect.succeed({ status: "ok" } as never);
    },
    provisionedRuntimeExecutable: () =>
      Effect.sync(() => {
        calls.push({ method: "executable", options: undefined });
        return "/usr/bin/goat";
      }),
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
    binding: () => (state.managed ? binding : undefined),
    admit: () =>
      state.admitted
        ? Effect.succeed({ selfNodeId: "local" })
        : Effect.fail(new SshInvalidTargetError({ message: "refused" })),
    hold: () => Effect.void,
    release: () => Effect.void,
    forget: () => Effect.void,
    registerCleanup: () => Effect.void,
  };
  return { guarded: guardPenManaged(manager, routes), calls, state };
};

describe("guardPenManaged", () => {
  it("keeps production SSH manager acquisition behind the Pen guard", () => {
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
    // Any value use of the service (an import, an alias, a yield) counts; building its layer and
    // naming its type do not.
    const occurrences = sources(root).filter((path) =>
      /\bSshEnvironmentManager\b(?!\s*\[|\.layer\b)/u.test(NodeFS.readFileSync(path, "utf8")),
    );
    expect(occurrences).toEqual([NodePath.join(root, "sshRemote", "penManagedSsh.ts")]);
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

  it.effect("a hub route read while Pen held it never reaches plain SSH once Pen let it go", () =>
    Effect.gen(function* () {
      const { guarded, calls, state } = fixture();
      // The hub proxy read the Pen route; the reconciler forgot the alias before SSH ran.
      state.managed = false;
      const ensured = yield* Effect.exit(
        guarded.ensureEnvironment(target).pipe(expectingPen(binding)),
      );
      const issued = yield* Effect.exit(
        guarded
          .issueClientSession(target, { subject: "hub-proxy", label: "hub", ttl: "1h", scopes: [] })
          .pipe(expectingPen(binding)),
      );
      expect([ensured._tag, issued._tag]).toEqual(["Failure", "Failure"]);
      // Another key under the same alias is not the machine the hub listed either.
      state.managed = true;
      const rekeyed = yield* Effect.exit(
        guarded
          .ensureEnvironment(target)
          .pipe(expectingPen({ ...binding, noisePub: "b".repeat(43) })),
      );
      expect(rekeyed._tag).toBe("Failure");
      expect(calls).toEqual([]);
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

  it.effect(
    "a Pen alias's runtime lookup is admitted first, and forgetting it never stops its runtime",
    () =>
      Effect.gen(function* () {
        const { guarded, calls, state } = fixture();
        state.admitted = false;
        const looked = yield* Effect.exit(
          guarded.provisionedRuntimeExecutable?.(target) ?? Effect.die("absent"),
        );
        expect(looked._tag).toBe("Failure");
        // Pen's list cannot be confirmed, yet what this machine holds for the alias still goes.
        yield* guarded.forgetEnvironment(target, { stopRuntime: "if_idle" });
        expect(calls).toEqual([{ method: "forget", options: { stopRuntime: "no" } }]);
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
  it.effect(
    "the methods that reuse an existing server are admitted too, and stay absent when the manager has none",
    () =>
      Effect.gen(function* () {
        const { guarded, state } = fixture();
        expect(guarded.issueExistingMcpSession).toBeUndefined();
        expect(guarded.existingEnvironment).toBeUndefined();
        const reached: string[] = [];
        const routes: PenManagedRoutesShape = {
          isManaged: () => true,
          binding: () => undefined,
          admit: () =>
            state.admitted
              ? Effect.succeed({ selfNodeId: "local" })
              : Effect.fail(new SshInvalidTargetError({ message: "refused" })),
          hold: () => Effect.void,
          release: () => Effect.void,
          forget: () => Effect.void,
          registerCleanup: () => Effect.void,
        };
        const withExisting = guardPenManaged(
          {
            ...guarded,
            issueExistingMcpSession: () =>
              Effect.sync(() => {
                reached.push("issue");
                return { token: "test", expiresAt: null, runtimeModeCeilingApplied: true };
              }),
            existingEnvironmentOther: () =>
              Effect.sync(() => {
                reached.push("other");
                return { kind: "absent" as const };
              }),
          },
          routes,
        );
        state.admitted = false;
        const environmentId = EnvironmentId.make("env-member");
        const refused = yield* Effect.flip(
          withExisting.issueExistingMcpSession?.(target, environmentId, {
            label: "mcp",
            ttl: "1h",
            runtimeModeCeiling: null,
          }) ?? Effect.die("guard dropped the method"),
        );
        expect(refused._tag).toBe("SshInvalidTargetError");
        expect(
          yield* (
            withExisting.existingEnvironmentOther?.(target, null) ??
              Effect.die("guard dropped the method")
          ),
        ).toEqual({ kind: "unavailable" });
        expect(reached).toEqual([]);
      }).pipe(Effect.provide(testServices)),
  );
});
