import { describe, expect, it, vi } from "@effect/vitest";
import { EnvironmentId, type DesktopBridge, type DesktopPenMembersState } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { prepareDesktopSshEnvironment, provisionDesktopSshEnvironment } from "./platform";

const target = { alias: "pen-test", hostname: "pen-test", username: "test", port: 22 };
const nodeId = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const environmentId = EnvironmentId.make("pen-test");
function fixture() {
  const ensure = vi.fn(async (_target, options) => ({
    target,
    httpBaseUrl: "http://127.0.0.1:3000",
    wsBaseUrl: "ws://127.0.0.1:3000",
    pairingToken: options?.issuePairingToken ? "pairing" : null,
  }));
  const issue = vi.fn(async () => ({ accessToken: "pen-session", expiresAt: null, scopes: [] }));
  const pair = vi.fn(async () => ({ access_token: "paired", scope: "" }));
  const bridge = {
    ensureSshEnvironment: ensure,
    issuePenMemberSession: issue,
    bootstrapSshBearerSession: pair,
    fetchSshEnvironmentDescriptor: async () => ({
      environmentId,
      label: "Pen",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "1.0.0",
      capabilities: { repositoryIdentity: true },
    }),
    fetchSshSessionState: async () => {
      throw new Error("[ssh_http:401] expired");
    },
  } as unknown as DesktopBridge;
  return { bridge, ensure, issue, pair };
}
describe("Pen SSH sessions", () => {
  it.effect(
    "a managed provision never asks for a pairing token and stores the issued session",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const result = yield* provisionDesktopSshEnvironment(f.bridge, target, undefined, {
          installation: "existing-only",
          penNodeId: nodeId,
        });
        expect(result.bearerToken).toBe("pen-session");
        expect(f.ensure).toHaveBeenCalledWith(
          target,
          expect.objectContaining({
            issuePairingToken: false,
            installation: "existing-only",
            penNodeId: nodeId,
          }),
        );
        expect(f.pair).not.toHaveBeenCalled();
      }),
  );
  it.effect("an expired managed bearer is renewed by issuing a session, not by pairing", () =>
    Effect.gen(function* () {
      const f = fixture();
      const result = yield* prepareDesktopSshEnvironment(f.bridge, {
        target,
        expectedEnvironmentId: environmentId,
        bearerToken: "expired",
        installation: "existing-only",
        penNodeId: nodeId,
      });
      expect(result.bearerToken).toBe("pen-session");
      expect(f.pair).not.toHaveBeenCalled();
    }),
  );
  it.effect(
    "a member whose issue fails pen-member-unsupported receives an update-required error",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const bridge = {
          ...f.bridge,
          issuePenMemberSession: async () => {
            throw new Error(
              "Error invoking remote method 'desktop:issue-pen-member-session': SshPairingError: GOAT on pen-test cannot issue Pen member sessions.",
            );
          },
        };
        const result = yield* Effect.result(
          provisionDesktopSshEnvironment(bridge, target, undefined, {
            installation: "existing-only",
            penNodeId: nodeId,
          }),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({
            _tag: "ConnectionBlockedError",
            reason: "unsupported",
            serverUpdateRequired: true,
          });
        expect(f.ensure).toHaveBeenCalledWith(
          target,
          expect.objectContaining({
            issuePairingToken: false,
            installation: "existing-only",
            penNodeId: nodeId,
          }),
        );
        expect(f.pair).not.toHaveBeenCalled();
      }),
  );
  it.effect("a person's Set up may install GOAT and still signs in as a Pen member", () =>
    Effect.gen(function* () {
      const f = fixture();
      const result = yield* provisionDesktopSshEnvironment(f.bridge, target, undefined, {
        penNodeId: nodeId,
      });
      expect(result.bearerToken).toBe("pen-session");
      expect(f.ensure.mock.calls[0]?.[1]).toMatchObject({
        issuePairingToken: false,
        penNodeId: nodeId,
      });
      expect(f.ensure.mock.calls[0]?.[1]).not.toHaveProperty("installation");
      expect(f.pair).not.toHaveBeenCalled();
    }),
  );
  it.effect("an existing-only IPC refusal reads not-set-up", () =>
    Effect.gen(function* () {
      const f = fixture();
      const bridge = {
        ...f.bridge,
        ensureSshEnvironment: async () => {
          throw new Error(
            "Error invoking remote method 'desktop:ensure-ssh-environment': SshLaunchError: pen-test has no GOAT this app can attach to without installing one.",
          );
        },
      };
      const result = yield* Effect.result(
        provisionDesktopSshEnvironment(bridge, target, undefined, { penNodeId: nodeId }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          _tag: "ConnectionBlockedError",
          existingRuntimeRequired: true,
        });
    }),
  );
  it.effect("an ordinary ssh route still pairs", () =>
    Effect.gen(function* () {
      const f = fixture();
      const result = yield* provisionDesktopSshEnvironment(f.bridge, target);
      expect(result.bearerToken).toBe("paired");
      expect(f.pair).toHaveBeenCalled();
      expect(f.issue).not.toHaveBeenCalled();
    }),
  );
});

describe("Pen members gateway", () => {
  it.effect("keeps a newer push when the initial read and later pushes are older", () =>
    Effect.gen(function* () {
      const { penMembersGateway } = yield* Effect.promise(() => import("./platformPen"));
      const subscribed = yield* Deferred.make<void>();
      let push: ((state: DesktopPenMembersState) => void) | undefined;
      let resolveRead: ((state: DesktopPenMembersState) => void) | undefined;
      const bridge = {
        onPenMembersChanged: (listener: (state: DesktopPenMembersState) => void) => {
          push = listener;
          return () => {};
        },
        getPenMembers: () => {
          Deferred.doneUnsafe(subscribed, Effect.void);
          return new Promise<DesktopPenMembersState>((resolve) => {
            resolveRead = resolve;
          });
        },
      } as unknown as DesktopBridge;
      const states = yield* penMembersGateway(bridge).desktop.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);
      push?.({ kind: "not-member", seq: 5 });
      resolveRead?.({ kind: "not-member", seq: 4 });
      push?.({ kind: "not-member", seq: 3 });
      push?.({ kind: "not-member", seq: 6 });
      expect(Array.from(yield* Fiber.join(states)).map((state) => state.seq)).toEqual([5, 6]);
    }),
  );
  it.effect("waits for hydration and follows the showPenMachines setting", () =>
    Effect.gen(function* () {
      const { penEnabledStream } = yield* Effect.promise(() => import("./platformPen"));
      const subscribed = yield* Deferred.make<void>();
      let changed = () => {};
      let hydrated = false;
      let enabled = true;
      const source = {
        getClientSettingsHydratedSnapshot: () => hydrated,
        getClientSettingsSnapshot: () => ({ showPenMachines: enabled }),
        subscribeClientSettings: (listener: () => void) => {
          changed = listener;
          return () => {};
        },
        subscribeClientSettingsHydration: (_listener: () => void) => {
          Deferred.doneUnsafe(subscribed, Effect.void);
          return () => {};
        },
      };
      const values = yield* penEnabledStream(source).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);
      changed();
      hydrated = true;
      changed();
      enabled = false;
      changed();
      expect(Array.from(yield* Fiber.join(values))).toEqual([true, false]);
    }),
  );
});
