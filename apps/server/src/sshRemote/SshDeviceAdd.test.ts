import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  HubNodesError,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  handoffSummary,
  SSH_PREFLIGHT_STEP_ORDER,
  type SshPreflightReport,
  type SshHostResult,
  type HubNode,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Broker from "../connections/ConnectionCatalogBroker.ts";
import * as Sessions from "../auth/SessionStore.ts";
import * as HubNodes from "../hubNodes/HubNodes.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Setup from "./SshHostSetup.ts";
import * as DeviceAdd from "./SshDeviceAdd.ts";

const threadId = ThreadId.make("caller");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("owner"),
  requestNamespace: "test",
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  client: undefined,
  thread: {
    threadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "provider",
  },
  grantedScopes: ["orchestration:read", "settings:write", "environment:maintain"],
  reauthorize: () => Effect.void,
};
const readyPreflight: SshPreflightReport = {
  host: "build",
  destination: { alias: "build", hostname: "build.example", user: "deploy", port: 22 },
  ready: true,
  platformKey: "linux-arm64",
  steps: SSH_PREFLIGHT_STEP_ORDER.map((id) => ({ id, state: "passed", summary: `${id} passed.` })),
};
const prepared: SshHostResult = {
  kind: "ok",
  status: { host: "build", state: "preparing", runtimeVersion: null, requestedVersion: "0.1.0" },
};
const hubNode: HubNode = {
  nodeId: EnvironmentId.make("build"),
  environmentId: EnvironmentId.make("build"),
  label: "Build",
  kind: "ssh",
  status: "online",
  lastSeenAt: null,
  addedBy: null,
  routes: [
    {
      routeId: "ssh:build",
      source: "registered",
      target: { kind: "ssh", alias: "build", hostname: null, username: null, port: null },
      status: "online",
      checkedAt: null,
      lastSeenAt: null,
      lastError: null,
    },
  ],
};
const fixture = (
  options: {
    blocked?: "failed" | "needs_review";
    catalog?: "absent" | "detached" | "timeout";
    /** unidentified: GOAT never ran there; preparing: identified only after a prepare. */
    hub?: "unidentified" | "preparing" | "unreachable";
    limited?: boolean;
    revoke?: boolean;
    authority?: boolean;
    typed?: boolean;
    configured?: boolean;
    fingerprint?: boolean;
    trustResult?: SshHostResult;
    prepareResult?: SshHostResult;
  } = {},
) =>
  Effect.gen(function* () {
    const calls: string[] = [];
    let pinned = !options.typed && !options.configured;
    const managedAlias = options.configured ? "goat-build" : "build";
    const checkedHosts: string[] = [];
    let checks = 0;
    let preparedOnce = false;
    const sourceReport = options.fingerprint
      ? {
          ...readyPreflight,
          steps: readyPreflight.steps.map((step) => ({ ...step, fingerprint: "SHA256:private" })),
        }
      : readyPreflight;
    const report = options.blocked
      ? {
          ...sourceReport,
          ready: false,
          steps: sourceReport.steps.map((step) =>
            step.id === "host_key" ? { ...step, state: options.blocked! } : step,
          ),
        }
      : sourceReport;
    const handoff = handoffSummary({
      handoffId: TurnItemId.make("approval"),
      kind: "approval",
      title: "Trust build?",
      reason: "Review key",
      requestedBy: {
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        path: "ssh.host_add",
      },
      target: { environmentId: scope.environmentId, path: "ssh.host_add" },
      dedupeKey: "test",
      state: "pending",
      expiresAt: null,
      createdAt: DateTime.makeUnsafe(0),
      actor: { type: "agent", threadId },
    });
    const layer = DeviceAdd.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Sessions.SessionStore)({ cookieName: "test", legacyCookieName: undefined }),
          Layer.mock(Threads.ThreadManagementService)({
            getThreadShell: () =>
              Effect.sync(() => {
                checks++;
                return liveThreadShell(threadId, {
                  runtimeMode:
                    options.limited || (options.revoke && checks >= 2)
                      ? "approval-required"
                      : "full-access",
                });
              }),
          }),
          Layer.mock(Setup.SshHostSetup)({
            resolveDestination: (input) =>
              Effect.succeed({
                input,
                ...(pinned || options.configured
                  ? { host: pinned ? managedAlias : "build", managed: pinned }
                  : {}),
              }),
            preflight: (input) =>
              Effect.sync(() => {
                calls.push("preflight");
                checkedHosts.push(input.host);
                return pinned && options.typed ? readyPreflight : report;
              }),
            add: () =>
              Effect.sync(() => {
                calls.push("approval");
                return (
                  options.trustResult ?? {
                    kind: "needs_human",
                    handoff,
                    next: { after: "approval", call: "goat_ssh_host_status" },
                    status: {
                      host: managedAlias,
                      state: "untrusted",
                      runtimeVersion: null,
                      requestedVersion: "0.1.0",
                    },
                  }
                );
              }),
            prepare: (input) =>
              Effect.sync(() => {
                expect(input.host).toBe(managedAlias);
                calls.push("prepare");
                preparedOnce = true;
                return options.prepareResult ?? prepared;
              }),
          }),
          Layer.mock(HubNodes.HubNodes)({
            add: (input, hubOptions) =>
              Effect.gen(function* () {
                calls.push("hub");
                expect(input).toMatchObject({ kind: "ssh", hostname: null });
                expect(hubOptions.requireIdentity).toBe(true);
                if (
                  options.hub === "unidentified" ||
                  (options.hub === "preparing" && !preparedOnce)
                )
                  return yield* new HubNodesError({
                    reason: "invalid_request",
                    detail: "GOAT has not run on build yet",
                  });
                if (options.hub === "unreachable")
                  return yield* new HubNodesError({
                    reason: "host_unavailable",
                    detail: "Could not reach build.",
                  });
                yield* hubOptions.beforeSave;
                return { created: true, node: hubNode };
              }),
          }),
          Layer.mock(Broker.ConnectionCatalogBroker)({
            invoke: (operation, timeout) =>
              Effect.gen(function* () {
                calls.push("broker");
                expect(operation.type).toBe("add_ssh");
                expect(timeout).toBe(600_000);
                if (options.catalog === "absent")
                  return yield* new Broker.ConnectionCatalogHostUnavailable();
                if (options.catalog === "detached")
                  return yield* new Broker.ConnectionCatalogHostDetached();
                if (options.catalog === "timeout")
                  return yield* new Broker.ConnectionCatalogTimeout({ timeoutMs: timeout });
                if (operation.type !== "add_ssh")
                  return yield* Effect.die("Unexpected catalog operation");
                expect(operation).toMatchObject({ host: "build", addedBy: { kind: "agent" } });
                if ("client" in operation.addedBy) {
                  expect(operation.addedBy).toMatchObject({ client: "Client" });
                  expect(operation.addedBy).not.toHaveProperty("threadId");
                } else expect(operation.addedBy).toMatchObject({ threadId });
                return {
                  type: "add_ssh",
                  created: true,
                  connection: {
                    environmentId: EnvironmentId.make("build"),
                    label: "Build",
                    enabled: true,
                    routes: [],
                  },
                };
              }),
          }),
        ),
      ),
    );
    const service = Context.get(yield* Layer.build(layer), DeviceAdd.SshDeviceAdd);
    const call = (callerScope = scope, host = "build") =>
      service.addDevice(
        { host },
        {
          kind: "mcp",
          scope: options.authority === false ? { ...callerScope, grantedScopes: [] } : callerScope,
        },
      );
    return {
      call,
      calls,
      checkedHosts,
      report,
      approve: () => {
        pinned = true;
      },
    };
  });
it.effect("failed preflight creates no handoff and never dispatches", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ blocked: "failed" });
    expect(yield* f.call()).toMatchObject({ outcome: "failed" });
    expect(f.calls).toEqual(["preflight"]);
  }),
);
it.effect("review requests approval and recall reruns preflight before catalog dispatch", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ typed: true, blocked: "needs_review" });
    expect(yield* f.call()).toMatchObject({
      outcome: "needs_human",
      next: { call: "goat_ssh_host_add", host: "build" },
    });
    expect(f.calls).toEqual(["preflight", "approval"]);
    f.approve();
    expect(yield* f.call()).toMatchObject({ outcome: "connected", created: true });
    expect(f.calls.filter((call) => call === "prepare")).toEqual([]);
    expect(f.calls).toEqual(["preflight", "approval", "preflight", "broker", "hub"]);
  }),
);
it.effect(
  "a thread with only orchestration:read can ask to trust a host and cannot prepare one",
  () =>
    Effect.gen(function* () {
      const seen: Array<ReadonlyArray<string>> = [];
      const threadOnly: McpInvocationScope = {
        ...scope,
        grantedScopes: ["orchestration:read"],
        reauthorize: (required) => Effect.sync(() => void seen.push(required)),
      };
      const trust = yield* fixture({ typed: true, blocked: "needs_review" });
      expect(yield* trust.call(threadOnly)).toMatchObject({
        outcome: "needs_human",
        next: { call: "goat_ssh_host_add", host: "build" },
      });
      expect(seen).toEqual([["orchestration:read"]]);
      expect(trust.calls).toEqual(["preflight", "approval"]);

      const readOnly = yield* fixture({ typed: true, blocked: "needs_review" });
      expect(yield* readOnly.call({ ...threadOnly, readOnly: true })).toMatchObject({
        outcome: "capability_denied",
        saved: false,
        reason: expect.stringContaining("writable"),
      });
      expect(readOnly.calls).toEqual(["preflight"]);

      const prepare = yield* fixture({ catalog: "absent", hub: "unidentified" });
      expect(yield* prepare.call(threadOnly)).toMatchObject({
        outcome: "capability_denied",
        saved: false,
        reason: expect.stringContaining("environment:maintain"),
      });
      expect(prepare.calls).toEqual(["preflight", "broker", "hub"]);
    }),
);
it.effect("a saved desktop connection is also registered on the hub", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(yield* f.call()).toMatchObject({
      outcome: "connected",
      hub: { saved: true, node: hubNode },
      desktopCatalog: "saved",
    });
    expect(f.calls).toEqual(["preflight", "broker", "hub"]);
  }),
);
it.effect("a hub failure after the desktop saved is reported without failing the add", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ hub: "unreachable" });
    expect(yield* f.call()).toMatchObject({
      outcome: "connected",
      created: true,
      hub: { saved: false, reason: "Could not reach build." },
      desktopCatalog: "saved",
    });
  }),
);
it.effect("an absent catalog saves the identified host to the hub alone", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ catalog: "absent" });
    const result = yield* f.call();
    expect(result).toMatchObject({
      outcome: "connected",
      created: true,
      connection: { environmentId: "build", routes: [{ kind: "ssh", host: "build" }] },
      hub: { saved: true, node: hubNode },
      desktopCatalog: "not_attached",
    });
    expect(isAddResult(result)).toBe(true);
    expect(f.calls).toEqual(["preflight", "broker", "hub"]);
  }),
);
it.effect("an absent catalog registers a host on the hub once preparation identifies it", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ catalog: "absent", hub: "preparing" });
    expect(yield* f.call()).toMatchObject({ outcome: "connected", desktopCatalog: "not_attached" });
    expect(f.calls).toEqual(["preflight", "broker", "hub", "prepare", "hub"]);
  }),
);
it.effect(
  "an absent catalog on a host still unidentified returns the real preparation result",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({ catalog: "absent", hub: "unidentified" });
      expect(yield* f.call()).toMatchObject({
        ...prepared,
        saved: false,
        reason: expect.stringContaining("Call this tool again once preparation finishes."),
      });
      expect(f.calls).toEqual(["preflight", "broker", "hub", "prepare", "hub"]);
    }),
);
it.effect.each(["detached", "timeout"] as const)(
  "a dispatched %s does not fall back or provision again",
  (catalog) =>
    Effect.gen(function* () {
      const f = yield* fixture({ catalog });
      expect(yield* f.call().pipe(Effect.flip)).toMatchObject({ code: "host_unavailable" });
      expect(f.calls).toEqual(["preflight", "broker"]);
    }),
);
it.effect("a limited caller prepares without writing the desktop catalog", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ limited: true });
    expect(yield* f.call()).toMatchObject({ ...prepared, saved: false });
    expect(f.calls).toEqual(["preflight", "prepare"]);
  }),
);
it.effect("full access revoked before dispatch stops the catalog write", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ revoke: true });
    expect(yield* f.call()).toMatchObject({
      outcome: "capability_denied",
      preflight: readyPreflight,
      saved: false,
      reason: expect.stringContaining("full-access"),
    });
    expect(f.calls).toEqual(["preflight"]);
  }),
);
it.effect("saving a trusted alias does not require settings authority", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ authority: false });
    expect(yield* f.call()).toMatchObject({ outcome: "connected" });
    expect(f.calls).toEqual(["preflight", "broker", "hub"]);
  }),
);
it.effect.each([{}, { configured: true }])(
  "full-access outside callers save a trusted alias (%s)",
  (options) =>
    Effect.gen(function* () {
      const f = yield* fixture(options);
      expect(
        yield* f.call({
          ...scope,
          thread: undefined,
          grantedScopes: ["orchestration:read", "orchestration:operate"],
          client: { sessionId: "client", label: "Client", access: "full-access" },
        }),
      ).toMatchObject({ outcome: "connected", created: true });
      expect(f.calls).toEqual(["preflight", "broker", "hub"]);
    }),
);
it.effect.each([
  { typed: true, blocked: "needs_review" as const },
  { configured: true, catalog: "absent" as const, hub: "unidentified" as const },
])(
  "outside-thread callers get the Settings instruction only when trust needs a handoff (%s)",
  (options) =>
    Effect.gen(function* () {
      const f = yield* fixture(options);
      expect(
        yield* f.call({
          ...scope,
          thread: undefined,
          client: { sessionId: "client", label: "Client", access: "full-access" },
        }),
      ).toMatchObject({
        saved: false,
        kind: "error",
        message: "Add this host in Settings → Connections.",
      });
      expect(f.calls).toEqual(options.catalog ? ["preflight", "broker", "hub"] : ["preflight"]);
    }),
);

const isAddInput = Schema.is(DeviceAdd.SshDeviceAddInput);
const isAddResult = Schema.is(DeviceAdd.SshDeviceAddResult);
it.each([
  { input: { host: "build" }, accepted: true },
  { input: { address: "deploy@build.example:2222" }, accepted: true },
  { input: {}, accepted: false },
  { input: { host: "build", address: "build.example" }, accepted: false },
])("requires exactly one host or address: $input", ({ input, accepted }) => {
  expect(isAddInput(input)).toBe(accepted);
});

it.effect.each([false, true])(
  "configured alias fallback pins before preparation (limited=%s)",
  (limited) =>
    Effect.gen(function* () {
      const f = yield* fixture({
        configured: true,
        catalog: "absent",
        hub: "unidentified",
        limited,
      });
      expect(yield* f.call()).toMatchObject({
        outcome: "needs_human",
        next: { call: "goat_ssh_host_add", host: "goat-build" },
      });
      expect(f.calls).toEqual(
        limited ? ["preflight", "approval"] : ["preflight", "broker", "hub", "approval"],
      );
      f.approve();
      expect(f.calls).not.toContain("prepare");
      expect(yield* f.call(scope, "goat-build")).toMatchObject({ ...prepared, saved: false });
      expect(f.checkedHosts).toEqual(["build", "goat-build"]);
      expect(f.calls).toEqual(
        limited
          ? ["preflight", "approval", "preflight", "prepare"]
          : [
              "preflight",
              "broker",
              "hub",
              "approval",
              "preflight",
              "broker",
              "hub",
              "prepare",
              "hub",
            ],
      );
    }),
);

it.effect("a new fingerprint returns preflight when an outside client lacks settings:write", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ typed: true, blocked: "needs_review" });
    const result = yield* f.call({
      ...scope,
      thread: undefined,
      grantedScopes: ["orchestration:read", "orchestration:operate"],
      client: { sessionId: "client", label: "Client", access: "full-access" },
    });
    expect(result).toMatchObject({
      outcome: "capability_denied",
      saved: false,
      reason: expect.stringMatching(
        /settings:write grant\. A person must approve this host's key: ask them to add it in Settings → Connections/u,
      ),
      preflight: {
        ready: false,
        steps: expect.arrayContaining([
          { id: "host_key", state: "needs_review", summary: "host_key passed." },
        ]),
      },
    });
    expect(isAddResult(result)).toBe(true);
    expect(f.calls).toEqual(["preflight"]);
  }),
);
it.effect("headless preparation returns preflight when environment:maintain is missing", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ catalog: "absent", hub: "unidentified" });
    expect(yield* f.call({ ...scope, grantedScopes: ["settings:write"] })).toMatchObject({
      outcome: "capability_denied",
      saved: false,
      preflight: readyPreflight,
      reason: expect.stringMatching(
        /environment:maintain grant\. Ask the person to connect it in Settings → Connections/u,
      ),
    });
    expect(f.calls).toEqual(["preflight", "broker", "hub"]);
  }),
);
it.effect("a denied fallback still says why the connection was not saved", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ configured: true, catalog: "absent", hub: "unidentified" });
    const result = yield* f.call({
      ...scope,
      thread: undefined,
      grantedScopes: ["orchestration:read", "orchestration:operate"],
      client: { sessionId: "client", label: "Client", access: "full-access" },
    });
    expect(result).toMatchObject({ outcome: "capability_denied", saved: false });
    expect(isAddResult(result) && "reason" in result ? result.reason : "").toMatch(
      /^GOAT has not run on build yet.*settings:write/su,
    );
    expect(f.calls).toEqual(["preflight", "broker", "hub"]);
  }),
);

it.effect.each([
  { blocked: "failed" as const },
  { typed: true, blocked: "needs_review" as const },
  {},
  { catalog: "absent" as const },
  { limited: true, authority: false },
  { typed: true, authority: false },
  { revoke: true },
  { typed: true, trustResult: prepared },
  {
    typed: true,
    trustResult: {
      kind: "error",
      code: "operation_failed",
      message: "Could not trust host.",
    } as const,
  },
  {
    catalog: "absent" as const,
    hub: "unidentified" as const,
    prepareResult: {
      kind: "error",
      code: "operation_failed",
      message: "Could not prepare host.",
    } as const,
  },
])("agent results strip fingerprints from every preflight outcome (%s)", (options) =>
  Effect.gen(function* () {
    const f = yield* fixture({ ...options, fingerprint: true });
    const result = yield* f.call();
    expect(result).toHaveProperty("preflight");
    expect(JSON.stringify(result)).not.toContain("fingerprint");
    expect(JSON.stringify(result)).not.toContain("SHA256:private");
    expect(f.report.steps.every((step) => step.fingerprint === "SHA256:private")).toBe(true);
  }),
);

it.effect("outside-thread handoff guidance also keeps fingerprints private", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ typed: true, blocked: "needs_review", fingerprint: true });
    const result = yield* f.call({ ...scope, thread: undefined });
    expect(result).toMatchObject({ kind: "error", saved: false, preflight: { ready: false } });
    expect(JSON.stringify(result)).not.toContain("fingerprint");
    expect(JSON.stringify(result)).not.toContain("SHA256:private");
  }),
);
