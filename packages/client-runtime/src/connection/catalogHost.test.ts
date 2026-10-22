import { vi } from "vite-plus/test";

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

import {
  ConnectionAddedBy,
  EnvironmentId,
  type ConnectionCatalogOperation,
  type DesktopSshEnvironmentTarget,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  BearerConnectionProfile,
  SshConnectionProfile,
  type ConnectionCatalogEntry,
} from "./catalog.ts";
import {
  ConnectionBlockedError,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionOnboarding from "./onboarding.ts";
import { handleConnectionCatalogOperation } from "./catalogHost.ts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
} from "../platform/storageDocument.ts";

const addedBy = Schema.decodeSync(ConnectionAddedBy)({
  kind: "agent",
  client: "test-agent",
  at: "2026-10-12T00:00:00.000Z",
});
const target: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "box.example.test",
  username: null,
  port: null,
};
const id = EnvironmentId.make("saved");
function sshEntry(sshTarget = target, enabled = true): ConnectionCatalogEntry {
  return {
    target: new SshConnectionTarget({
      environmentId: id,
      label: "Saved box",
      connectionId: "ssh:saved",
    }),
    profile: Option.some(
      new SshConnectionProfile({
        environmentId: id,
        label: "Saved box",
        connectionId: "ssh:saved",
        target: sshTarget,
        addedBy,
      }),
    ),
    enabled,
  };
}
const primary: ConnectionCatalogEntry = {
  target: new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("primary"),
    label: "Local",
    httpBaseUrl: "http://localhost/",
    wsBaseUrl: "ws://localhost/",
  }),
  profile: Option.none(),
  enabled: true,
};
const direct: ConnectionCatalogEntry = {
  target: new BearerConnectionTarget({
    environmentId: id,
    label: "Saved box",
    connectionId: "bearer:saved",
  }),
  profile: Option.some(
    new BearerConnectionProfile({
      environmentId: id,
      label: "Saved box",
      connectionId: "bearer:saved",
      httpBaseUrl: "https://box.example.test/",
      wsBaseUrl: "wss://box.example.test/",
    }),
  ),
  enabled: true,
};
const relay = {
  target: new RelayConnectionTarget({ environmentId: id, label: "Saved box" }),
  profile: Option.none(),
};

function run(
  operation: ConnectionCatalogOperation,
  initial: ConnectionCatalogEntry[],
  options?: {
    fail?: boolean;
    failureMessage?: string;
    registeredEntry?: ConnectionCatalogEntry;
    resolved?: DesktopSshEnvironmentTarget;
  },
) {
  return Effect.gen(function* () {
    const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(initial.map((entry) => [entry.target.environmentId, entry])),
    );
    const networkStatus = yield* SubscriptionRef.make<"online" | "offline" | "unknown">("online");
    const inputs: ConnectionOnboarding.SshConnectionInput[] = [];
    const removed: EnvironmentId[] = [];
    const unused = () => Effect.die("unused registry method");
    const registry = EnvironmentRegistry.EnvironmentRegistry.of({
      entries,
      networkStatus,
      start: Effect.void,
      register: unused,
      registerPlatform: unused,
      reconcilePlatform: unused,
      remove: (environmentId) =>
        SubscriptionRef.update(entries, (current) => {
          removed.push(environmentId);
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        }),
      removeRoute: unused,
      reorderRoutes: unused,
      removeRelayEnvironments: unused,
      retryNow: unused,
      setEnabled: unused,
      setCompatibility: unused,
      state: unused,
      stateChanges: () => Stream.die("unused"),
      run: unused,
      runStream: () => Stream.die("unused"),
      followStream: () => Stream.die("unused"),
    });
    const onboarding = ConnectionOnboarding.ConnectionOnboarding.of({
      registerPairing: unused,
      updateBearer: unused,
      registerSsh: (input) =>
        Effect.gen(function* () {
          inputs.push(input);
          if (options?.failureMessage)
            return yield* new ConnectionBlockedError({
              reason: "authentication",
              detail: options.failureMessage,
            });
          if (options?.fail)
            return yield* new ConnectionBlockedError({
              reason: "authentication",
              detail: "key-based login failed",
            });
          const entry = options?.registeredEntry ?? sshEntry(input.target);
          yield* SubscriptionRef.update(entries, (current) =>
            new Map(current).set(entry.target.environmentId, entry),
          );
          return entry.target.environmentId;
        }),
    });
    const invoke = () =>
      handleConnectionCatalogOperation(operation, () =>
        Effect.succeed(options?.resolved ?? target),
      ).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ConnectionOnboarding.ConnectionOnboarding, onboarding),
      );
    const result = yield* invoke();
    return {
      result,
      repeat: invoke,
      readEntries: SubscriptionRef.get(entries),
      inputs,
      removed,
      entries: yield* SubscriptionRef.get(entries),
    };
  });
}

describe("connection catalog host", () => {
  it.effect("lists all routes and attribution while skipping local platform entries", () =>
    Effect.gen(function* () {
      const secondary = {
        ...direct,
        target: new BearerConnectionTarget({
          environmentId: EnvironmentId.make("secondary"),
          label: "WSL",
          connectionId: "local:wsl:Ubuntu",
        }),
      };
      const entry = {
        ...direct,
        alternateRoutes: [{ target: sshEntry().target, profile: sshEntry().profile }, relay],
      };
      const { result } = yield* run({ type: "list" }, [primary, secondary, entry]);
      expect(result).toEqual({
        type: "list",
        connections: [
          {
            environmentId: id,
            label: "Saved box",
            enabled: true,
            addedBy,
            routes: [
              { kind: "direct", httpBaseUrl: "https://box.example.test/" },
              {
                kind: "ssh",
                host: "devbox",
                hostname: "box.example.test",
                username: null,
                port: null,
              },
              { kind: "t3-connect" },
            ],
          },
        ],
      });
      expect(JSON.stringify(result)).not.toMatch(/token|credential|wsBaseUrl|connectionId/);
    }),
  );
  it.effect.each([
    ["alias", sshEntry(), { ...target, hostname: "changed.example.test" }],
    [
      "normalized endpoint",
      sshEntry(),
      { ...target, alias: "alternate", hostname: "BOX.EXAMPLE.TEST", username: "", port: 22 },
    ],
    [
      "disabled alternate route",
      {
        ...direct,
        enabled: false,
        alternateRoutes: [{ target: sshEntry().target, profile: sshEntry().profile }],
      },
      target,
    ],
  ] as const)("reuses an existing %s without provisioning", ([_name, entry, resolved]) =>
    Effect.gen(function* () {
      const { result, inputs } = yield* run(
        { type: "add_ssh", host: resolved.alias, addedBy },
        [entry],
        { resolved },
      );
      expect(result).toMatchObject({
        type: "add_ssh",
        created: false,
        connection: { environmentId: id, enabled: entry.enabled },
      });
      expect(inputs).toEqual([]);
    }),
  );
  it.effect("saves new SSH entries with key-only authentication and attribution", () =>
    Effect.gen(function* () {
      const { result, inputs } = yield* run(
        { type: "add_ssh", host: "devbox", label: "Agent box", addedBy },
        [],
      );
      expect(result).toMatchObject({ type: "add_ssh", created: true });
      expect(inputs).toEqual([{ target, label: "Agent box", keyOnly: true, addedBy }]);
    }),
  );
  it.effect("returns provisioning failures without failing the effect", () =>
    Effect.gen(function* () {
      const { result } = yield* run({ type: "add_ssh", host: "devbox", addedBy }, [], {
        fail: true,
      });
      expect(result).toEqual({
        type: "failure",
        reason: "connection_failed",
        message: "key-based login failed",
      });
    }),
  );
  it.effect.each([
    ["direct", direct],
    ["T3 Connect", { ...relay, enabled: true }],
  ] as const)("adds an SSH route to an existing %s machine with created:false", ([_name, entry]) =>
    Effect.gen(function* () {
      const registeredEntry = {
        ...entry,
        alternateRoutes: [{ target: sshEntry().target, profile: sshEntry().profile }],
      };
      const { result, inputs } = yield* run({ type: "add_ssh", host: "devbox", addedBy }, [entry], {
        registeredEntry,
      });
      expect(inputs).toHaveLength(1);
      expect(result).toMatchObject({
        type: "add_ssh",
        created: false,
        connection: {
          environmentId: id,
          routes: expect.arrayContaining([
            { kind: "ssh", host: "devbox", hostname: target.hostname, username: null, port: null },
          ]),
        },
      });
    }),
  );
  it.effect.each([
    primary,
    {
      ...direct,
      target: new BearerConnectionTarget({
        environmentId: id,
        label: "WSL",
        connectionId: "local:wsl:Ubuntu",
      }),
    },
  ])("refuses an SSH host that resolves to a platform environment", (entry) =>
    Effect.gen(function* () {
      const { result } = yield* run({ type: "add_ssh", host: "devbox", addedBy }, [entry], {
        registeredEntry: entry,
      });
      expect(result).toEqual({
        type: "failure",
        reason: "refused",
        message: "devbox reaches this machine's own environment; it is already in the sidebar.",
      });
    }),
  );
  it.effect("strips Electron and tagged error prefixes from key-only failures", () =>
    Effect.gen(function* () {
      const { result } = yield* run({ type: "add_ssh", host: "devbox", addedBy }, [], {
        failureMessage:
          "Error invoking remote method 'desktop:ensure-ssh-environment': SshPasswordPromptError: key-based login failed",
      });
      expect(result).toEqual({
        type: "failure",
        reason: "connection_failed",
        message: "key-based login failed",
      });
    }),
  );
  it.effect("refuses primary, secondary local, and relay-managed removal", () =>
    Effect.gen(function* () {
      const secondary = {
        ...direct,
        target: new BearerConnectionTarget({
          environmentId: id,
          label: "WSL",
          connectionId: "local:wsl:Ubuntu",
        }),
      };
      for (const entry of [primary, secondary, { ...sshEntry(), alternateRoutes: [relay] }]) {
        const { result, removed } = yield* run(
          { type: "remove", environmentId: entry.target.environmentId },
          [entry],
        );
        expect(result).toMatchObject({ type: "failure", reason: "refused" });
        expect(removed).toEqual([]);
      }
    }),
  );
  it.effect("removes saved entries and reports unknown ids", () =>
    Effect.gen(function* () {
      const { result, removed, entries } = yield* run({ type: "remove", environmentId: id }, [
        sshEntry(),
      ]);
      expect(result).toMatchObject({ type: "remove", removed: { environmentId: id, addedBy } });
      expect(removed).toEqual([id]);
      expect(entries.size).toBe(0);
      expect((yield* run({ type: "remove", environmentId: id }, [])).result).toMatchObject({
        type: "failure",
        reason: "not_found",
      });
    }),
  );
  it("preserves agent attribution through persisted catalog encode/decode", () => {
    const profile = Option.getOrThrow(sshEntry().profile);
    const schema = Schema.fromJsonString(ConnectionCatalogDocument);
    const encoded = Schema.encodeSync(schema)({
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      profiles: [profile],
    });
    expect(Schema.decodeSync(schema)(encoded).profiles[0]).toMatchObject({ addedBy });
  });
});

it.effect("repeated SSH adds deduplicate against the saved catalog without registering again", () =>
  Effect.gen(function* () {
    const f = yield* run({ type: "add_ssh", host: "devbox", addedBy }, []);
    expect(f.result).toMatchObject({ type: "add_ssh", created: true });
    const repeated = yield* f.repeat();
    expect(repeated).toMatchObject({ type: "add_ssh", created: false });
    if (repeated.type === "add_ssh" && f.result.type === "add_ssh")
      expect(repeated.connection).toEqual(f.result.connection);
    expect(f.inputs).toHaveLength(1);
    expect((yield* f.readEntries).size).toBe(1);
  }),
);
