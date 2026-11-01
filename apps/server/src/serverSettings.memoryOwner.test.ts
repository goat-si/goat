import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Config from "./config.ts";
import * as Settings from "./serverSettings.ts";
import * as Identity from "./environment/ServerEnvironment.ts";
import * as Secrets from "./auth/ServerSecretStore.ts";
import * as Persistence from "./persistence/Sqlite.ts";

const owner = M.EnvironmentId.make("fixture-owner");
const requester = M.EnvironmentId.make("fixture-requester");
const space = M.MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
const decodePersistedSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(M.ServerSettings));
const isOwnerPolicy = Schema.is(M.MemoryOwnerSourceReadPolicy);
const requestId = M.MemoryOperationId.make("00000000-0000-4000-8000-000000000002");
const identity = Layer.succeed(Identity.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(owner),
});
const fixture = () =>
  Settings.layer.pipe(
    Layer.provide(Secrets.layer),
    Layer.provide(identity),
    Layer.provideMerge(Layer.fresh(Persistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(Config.layerTest(process.cwd(), { prefix: "goat-owner-policy-test-" })),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
const initializeWithPolicy = (storedPolicy = M.DEFAULT_MEMORY_OWNER_SOURCE_READ_POLICY) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Config.ServerConfig;
    yield* fs.writeFileString(
      config.settingsPath,
      JSON.stringify({
        memoryHub: { mode: "hub", memorySpaceId: space },
        memoryOwnerSourceReadPolicy: storedPolicy,
      }),
    );
    const settings = yield* Settings.ServerSettingsService;
    yield* settings.getSettings;
    return {
      settings,
      fs,
      config,
      policy: yield* Settings.MemoryOwnerSourceReadCommittedPolicy,
      admin: yield* Settings.MemoryOwnerSourceReadPolicyAdministration,
    };
  });
const initialize = initializeWithPolicy();
const update = (
  admin: Settings.MemoryOwnerSourceReadPolicyAdministration["Service"],
  version: number,
  ids: ReadonlyArray<M.EnvironmentId>,
) =>
  admin.update(
    { requestId, expectedVersion: version, allowedRequesterEnvironmentIds: ids },
    Effect.void,
  );

const ackFor = (removal: M.MemoryOwnerRemoval): M.MemorySourceReadRevokeAck => ({
  memorySpaceId: removal.memorySpaceId,
  ownerEnvironmentId: removal.ownerEnvironmentId,
  requesterEnvironmentId: removal.requesterEnvironmentId,
  removalEpoch: removal.removalEpoch,
  revokedThroughEpoch: removal.removalEpoch,
});
const requesters = Array.from({ length: M.MEMORY_HUB_MAX_MEMBERS }, (_, i) =>
  M.EnvironmentId.make(`fixture-capacity-${i}`),
);
const expectValid = (policy: M.MemoryOwnerSourceReadPolicy) => {
  expect(isOwnerPolicy(policy)).toBe(true);
  expect(
    new Set(
      [...policy.removals, ...policy.enrollments].map((p) =>
        JSON.stringify([p.memorySpaceId, p.ownerEnvironmentId, p.requesterEnvironmentId]),
      ),
    ).size,
  ).toBeLessThanOrEqual(M.MEMORY_HUB_MAX_MEMBERS);
};

it.effect("default denies and owner administration requires its settings permit", () =>
  Effect.gen(function* () {
    const { policy, admin } = yield* initialize;
    expect(yield* policy.read).toEqual({
      policy: M.DEFAULT_MEMORY_OWNER_SOURCE_READ_POLICY,
      version: 0,
    });
    const deny = Effect.fail(new M.MemoryRpcError({ code: "unavailable" }));
    expect((yield* Effect.flip(admin.get(deny))).code).toBe("unavailable");
    expect(
      (yield* Effect.flip(
        admin.update(
          { requestId, expectedVersion: 0, allowedRequesterEnvironmentIds: [requester] },
          deny,
        ),
      ))._tag,
    ).toBe("MemoryRpcError");
    expect((yield* policy.read).version).toBe(0);
  }).pipe(Effect.provide(fixture())),
);

it.effect("CAS rejects a stale write without changing policy or version", () =>
  Effect.gen(function* () {
    const { policy, admin } = yield* initialize;
    const granted = yield* update(admin, 0, [requester]);
    expect(granted.policy.enrollments).toEqual([
      {
        memorySpaceId: space,
        ownerEnvironmentId: owner,
        requesterEnvironmentId: requester,
        ownerPolicyEpoch: 1,
        state: "active",
      },
    ]);
    expect(yield* Effect.flip(update(admin, 0, []))).toMatchObject({ code: "revision_changed" });
    expect(yield* policy.read).toEqual({ policy: granted.policy, version: 1 });
  }).pipe(Effect.provide(fixture())),
);

it.effect(
  "removal persists the pair and barrier; only a matching ack activates a newer enrollment",
  () =>
    Effect.gen(function* () {
      const { policy, admin, fs, config } = yield* initialize;
      const granted = yield* update(admin, 0, [requester]);
      const removed = yield* update(admin, granted.version, []);
      expect(removed.policy.ownerPolicyEpoch).toBeGreaterThan(granted.policy.ownerPolicyEpoch);
      expect(removed.revocationPropagation).toBe("pending");
      const removal = removed.policy.removals[0]!;
      expect(removal).toMatchObject({
        memorySpaceId: space,
        ownerEnvironmentId: owner,
        requesterEnvironmentId: requester,
        state: "pending",
      });
      const pending = yield* update(admin, removed.version, [requester]);
      expect(pending.policy.allowedRequesterEnvironmentIds).toEqual([]);
      expect(pending.policy.enrollments[0]?.state).toBe("pending");
      const ack = {
        memorySpaceId: space,
        ownerEnvironmentId: owner,
        requesterEnvironmentId: requester,
        removalEpoch: removal.removalEpoch,
        revokedThroughEpoch: removal.removalEpoch + 10,
      };
      expect(
        yield* policy.recordRevokeAck({
          ...ack,
          requesterEnvironmentId: M.EnvironmentId.make("fixture-other"),
        }),
      ).toEqual({ policy: pending.policy, version: pending.version });
      expect(
        yield* policy.recordRevokeAck({ ...ack, removalEpoch: removal.removalEpoch - 1 }),
      ).toEqual({ policy: pending.policy, version: pending.version });
      const settled = yield* policy.recordRevokeAck(ack);
      expect(settled.policy.removals).toEqual([]);
      expect(settled.policy.enrollments[0]?.state).toBe("active");
      expect(settled.policy.enrollments[0]?.ownerPolicyEpoch).toBeGreaterThan(
        ack.revokedThroughEpoch,
      );
      expect(settled.policy.allowedRequesterEnvironmentIds).toEqual([requester]);
      expect((yield* admin.get(Effect.void)).revocationPropagation).toBe("acknowledged");
      expect(yield* policy.recordRevokeAck(ack)).toBe(settled);
      const saved = yield* decodePersistedSettings(yield* fs.readFileString(config.settingsPath));
      expect(saved.memoryOwnerSourceReadPolicy).toEqual(settled.policy);
      expect(saved.memoryOwnerSourceReadPolicyVersion).toBe(settled.version);
      expect(Object.isFrozen(settled.policy.enrollments)).toBe(true);
      expect(Object.isFrozen(settled.policy.removals)).toBe(true);
    }).pipe(Effect.provide(fixture())),
);

it.effect("removing a pending reenrollment keeps the revocation closed after its ack", () =>
  Effect.gen(function* () {
    const { policy, admin } = yield* initialize;
    yield* update(admin, 0, [requester]);
    const removed = yield* update(admin, 1, []);
    yield* update(admin, 2, [requester]);
    yield* update(admin, 3, []);
    const r = removed.policy.removals[0]!;
    const settled = yield* policy.recordRevokeAck({
      memorySpaceId: r.memorySpaceId,
      ownerEnvironmentId: r.ownerEnvironmentId,
      requesterEnvironmentId: r.requesterEnvironmentId,
      removalEpoch: r.removalEpoch,
      revokedThroughEpoch: r.removalEpoch,
    });
    expect(settled.policy.allowedRequesterEnvironmentIds).toEqual([]);
    expect(settled.policy.enrollments).toEqual([]);
  }).pipe(Effect.provide(fixture())),
);

it.effect("unbound policy cannot enroll; duplicate requesters and invalid ack are rejected", () =>
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    yield* settings.getSettings;
    const admin = yield* Settings.MemoryOwnerSourceReadPolicyAdministration;
    const policy = yield* Settings.MemoryOwnerSourceReadCommittedPolicy;
    expect(yield* Effect.flip(update(admin, 0, [requester]))).toMatchObject({
      code: "bootstrap_required",
    });
    expect(yield* Effect.flip(update(admin, 0, [requester, requester]))).toMatchObject({
      code: "invalid_output",
    });
    expect(
      yield* Effect.flip(
        policy.recordRevokeAck({
          memorySpaceId: space,
          ownerEnvironmentId: owner,
          requesterEnvironmentId: requester,
          removalEpoch: 2,
          revokedThroughEpoch: 1,
        }),
      ),
    ).toMatchObject({ code: "invalid_output" });
    expect((yield* policy.read).version).toBe(0);
  }).pipe(Effect.provide(fixture())),
);

it.effect(
  "changes retain only the latest committed value and unrelated settings do not publish",
  () =>
    Effect.gen(function* () {
      const { settings, policy, admin } = yield* initialize;
      const changes = yield* policy.changes;
      yield* update(admin, 0, [requester]);
      const removed = yield* update(admin, 1, []);
      yield* settings.updateSettings({ standingInstructions: "fixture" });
      const observations = yield* Stream.runCollect(changes.pipe(Stream.take(2)));
      expect(observations.map((v) => v.version)).toEqual([0, 2]);
      expect(observations[1]?.policy).toEqual(removed.policy);
    }).pipe(Effect.provide(fixture())),
);

it.effect("a settings write failure cannot publish an enrollment or settle a revocation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let failRename = false;
    const failingFs = {
      ...fs,
      rename: (from: string, to: string) =>
        failRename
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "rename",
              }),
            )
          : fs.rename(from, to),
    };
    yield* Effect.gen(function* () {
      const { policy, admin } = yield* initialize;
      const before = yield* policy.read;
      failRename = true;
      expect((yield* Effect.flip(update(admin, 0, [requester])))._tag).toBe("ServerSettingsError");
      expect(yield* policy.read).toBe(before);
      failRename = false;
      yield* update(admin, 0, [requester]);
      const removed = yield* update(admin, 1, []);
      yield* update(admin, 2, [requester]);
      const pending = yield* policy.read;
      failRename = true;
      expect(
        (yield* Effect.flip(policy.recordRevokeAck(ackFor(removed.policy.removals[0]!))))._tag,
      ).toBe("ServerSettingsError");
      expect(yield* policy.read).toBe(pending);
    }).pipe(
      Effect.provide(
        Settings.layer.pipe(
          Layer.provide(Secrets.layer),
          Layer.provide(identity),
          Layer.provideMerge(Layer.fresh(Persistence.layerMemory)),
          Layer.provideMerge(
            Layer.fresh(Config.layerTest(process.cwd(), { prefix: "goat-owner-failure-test-" })),
          ),
          Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, failingFs)),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("restart preserves a pending reenrollment and its exact revocation pair", () =>
  Effect.gen(function* () {
    const { admin } = yield* initialize;
    yield* update(admin, 0, [requester]);
    yield* update(admin, 1, []);
    const pending = yield* update(admin, 2, [requester]);
    yield* Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.getSettings;
      const policy = yield* Settings.MemoryOwnerSourceReadCommittedPolicy;
      expect(yield* policy.read).toEqual({ policy: pending.policy, version: pending.version });
      const removal = pending.policy.removals[0]!;
      const settled = yield* policy.recordRevokeAck({
        memorySpaceId: removal.memorySpaceId,
        ownerEnvironmentId: removal.ownerEnvironmentId,
        requesterEnvironmentId: removal.requesterEnvironmentId,
        removalEpoch: removal.removalEpoch,
        revokedThroughEpoch: removal.removalEpoch,
      });
      expect(settled.policy.allowedRequesterEnvironmentIds).toEqual([requester]);
    }).pipe(
      Effect.provide(
        Layer.fresh(Settings.layer).pipe(
          Layer.provide(Secrets.layer),
          Layer.provide(identity),
          Layer.provide(Layer.fresh(Persistence.layerMemory)),
        ),
      ),
    );
  }).pipe(Effect.provide(fixture())),
);

it.effect("the durable rename precedes committed policy publication", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let policy: Settings.MemoryOwnerSourceReadCommittedPolicy["Service"] | undefined;
    const versionsAtRename: number[] = [];
    const observingFs = {
      ...fs,
      rename: (from: string, to: string) =>
        fs.rename(from, to).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              if (!policy) return;
              const saved = yield* decodePersistedSettings(yield* fs.readFileString(to)).pipe(
                Effect.orDie,
              );
              const before = yield* policy.read;
              expect(saved.memoryOwnerSourceReadPolicyVersion).toBe(before.version + 1);
              expect(isOwnerPolicy(saved.memoryOwnerSourceReadPolicy)).toBe(true);
              if (saved.memoryOwnerSourceReadPolicyVersion === 4) {
                expect(saved.memoryOwnerSourceReadPolicy.removals).toEqual([]);
                expect(saved.memoryOwnerSourceReadPolicy.allowedRequesterEnvironmentIds).toEqual([
                  requester,
                ]);
                expect(before.policy.enrollments[0]?.state).toBe("pending");
              }
              versionsAtRename.push(before.version);
            }),
          ),
        ),
    };
    yield* Effect.gen(function* () {
      const initialized = yield* initialize;
      policy = initialized.policy;
      yield* update(initialized.admin, 0, [requester]);
      const removed = yield* update(initialized.admin, 1, []);
      yield* update(initialized.admin, 2, [requester]);
      yield* policy.recordRevokeAck(ackFor(removed.policy.removals[0]!));
      expect(versionsAtRename).toEqual([0, 1, 2, 3]);
      expect((yield* policy.read).version).toBe(4);
    }).pipe(
      Effect.provide(
        Settings.layer.pipe(
          Layer.provide(Secrets.layer),
          Layer.provide(identity),
          Layer.provideMerge(Layer.fresh(Persistence.layerMemory)),
          Layer.provideMerge(
            Layer.fresh(Config.layerTest(process.cwd(), { prefix: "goat-owner-order-test-" })),
          ),
          Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, observingFs)),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("acknowledged pairs do not exhaust future enrollment or revocation slots", () =>
  Effect.gen(function* () {
    const { policy, admin } = yield* initialize;
    let version = 0;
    for (const id of [...requesters, requester]) {
      const granted = yield* update(admin, version, [id]);
      const removed = yield* update(admin, granted.version, []);
      const settled = yield* policy.recordRevokeAck(ackFor(removed.policy.removals[0]!));
      expect(settled.policy.enrollments).toEqual([]);
      expectValid(settled.policy);
      version = settled.version;
    }
    expect((yield* policy.read).policy.removals).toEqual([]);
    expect(version).toBe((M.MEMORY_HUB_MAX_MEMBERS + 1) * 3);
  }).pipe(Effect.provide(fixture())),
);

it.effect("admission reserves distinct pairs and rejects overflow before persistence", () =>
  Effect.gen(function* () {
    const { policy, admin, fs, config } = yield* initialize;
    const granted = yield* update(admin, 0, requesters);
    const half = requesters.slice(64);
    const removed = yield* update(admin, granted.version, half);
    const pending = yield* update(admin, removed.version, requesters);
    expect(pending.policy.removals).toHaveLength(64);
    expect(pending.policy.enrollments).toHaveLength(M.MEMORY_HUB_MAX_MEMBERS);
    expect(pending.policy.enrollments.filter((e) => e.state === "pending")).toHaveLength(64);
    expectValid(pending.policy);
    const before = yield* policy.read;
    const persisted = yield* fs.readFileString(config.settingsPath);
    expect(yield* Effect.flip(update(admin, before.version, [...half, requester]))).toMatchObject({
      _tag: "MemoryRpcError",
      code: "capacity_exceeded",
      capacity: { dimension: "members", current: 129, limit: 128, reclaimable: 0 },
    });
    expect(yield* policy.read).toBe(before);
    expect(yield* fs.readFileString(config.settingsPath)).toBe(persisted);
    // Dropping pending enrollments cannot discard their unacknowledged barriers.
    const emptied = yield* update(admin, before.version, []);
    expect(emptied.policy.allowedRequesterEnvironmentIds).toEqual([]);
    expect(emptied.policy.enrollments).toEqual([]);
    expect(emptied.policy.removals).toHaveLength(128);
    expectValid(emptied.policy);
    expect(yield* Effect.flip(update(admin, emptied.version, [requester]))).toMatchObject({
      code: "capacity_exceeded",
    });
    const settled = yield* policy.recordRevokeAck(ackFor(emptied.policy.removals[0]!));
    const admitted = yield* update(admin, settled.version, [requester]);
    expect(admitted.policy.allowedRequesterEnvironmentIds).toEqual([requester]);
    expectValid(admitted.policy);
    const revoked = yield* update(admin, admitted.version, []);
    expect(revoked.policy.removals).toHaveLength(128);
    expectValid(revoked.policy);
  }).pipe(Effect.provide(fixture())),
);

it.effect("every committed pair remains individually revocable at the reservation limit", () =>
  Effect.gen(function* () {
    const { admin } = yield* initialize;
    let state = yield* update(admin, 0, requesters);
    for (let i = 0; i < requesters.length; i++) {
      state = yield* update(admin, state.version, requesters.slice(i + 1));
      expect(state.policy.allowedRequesterEnvironmentIds).toEqual(requesters.slice(i + 1));
      expect(state.policy.removals).toHaveLength(i + 1);
      expect(state.policy.removals.every((r) => r.state === "pending")).toBe(true);
      expectValid(state.policy);
    }
    expect(state.policy.enrollments).toEqual([]);
  }).pipe(Effect.provide(fixture())),
);

const legacyPolicy: M.MemoryOwnerSourceReadPolicy = {
  allowedRequesterEnvironmentIds: [],
  ownerPolicyEpoch: 128,
  enrollments: [],
  removals: requesters.map((requesterEnvironmentId, i) => ({
    memorySpaceId: space,
    ownerEnvironmentId: owner,
    requesterEnvironmentId,
    removalEpoch: i + 1,
    state: "acknowledged",
    ack: {
      memorySpaceId: space,
      ownerEnvironmentId: owner,
      requesterEnvironmentId,
      removalEpoch: i + 1,
      revokedThroughEpoch: 1000 + i,
    },
  })),
};

it.effect("decoded legacy acknowledgements are retired on update with their fences retained", () =>
  Effect.gen(function* () {
    const { policy, admin, fs, config } = yield* initializeWithPolicy(legacyPolicy);
    expect((yield* policy.read).policy).toEqual(legacyPolicy);
    expect(isOwnerPolicy(legacyPolicy)).toBe(true);
    const granted = yield* update(admin, 0, [requesters[0]!, requester]);
    expect(granted.policy.removals).toEqual([]);
    for (const enrollment of granted.policy.enrollments) {
      expect(enrollment.state).toBe("active");
      expect(enrollment.ownerPolicyEpoch).toBeGreaterThan(1127);
    }
    expectValid(granted.policy);
    const removed = yield* update(admin, granted.version, []);
    expect(removed.policy.removals).toHaveLength(2);
    expectValid(removed.policy);
    const saved = yield* decodePersistedSettings(yield* fs.readFileString(config.settingsPath));
    expect(saved.memoryOwnerSourceReadPolicy).toEqual(removed.policy);
  }).pipe(Effect.provide(fixture())),
);

it.effect(
  "matching ack also retires legacy records while duplicate or mismatched ack is a no-op",
  () =>
    Effect.gen(function* () {
      const pending: M.MemoryOwnerRemoval = {
        memorySpaceId: space,
        ownerEnvironmentId: owner,
        requesterEnvironmentId: requester,
        removalEpoch: 128,
        state: "pending",
      };
      const legacy = { ...legacyPolicy, removals: [...legacyPolicy.removals.slice(1), pending] };
      const { policy, fs, config } = yield* initializeWithPolicy(legacy);
      const before = yield* policy.read;
      const bytes = yield* fs.readFileString(config.settingsPath);
      expect(yield* policy.recordRevokeAck({ ...ackFor(pending), removalEpoch: 127 })).toBe(before);
      expect(yield* fs.readFileString(config.settingsPath)).toBe(bytes);
      const settled = yield* policy.recordRevokeAck(ackFor(pending));
      expect(settled.version).toBe(1);
      expect(settled.policy.removals).toEqual([]);
      expect(settled.policy.ownerPolicyEpoch).toBe(1127);
      expectValid(settled.policy);
      const saved = yield* fs.readFileString(config.settingsPath);
      expect(yield* policy.recordRevokeAck(ackFor(pending))).toBe(settled);
      expect(yield* fs.readFileString(config.settingsPath)).toBe(saved);
    }).pipe(Effect.provide(fixture())),
);

it.effect("invalid startup settings do not advertise a last-valid publication", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Config.ServerConfig;
    yield* fs.writeFileString(config.settingsPath, '{"memoryHub":');
    const settings = yield* Settings.ServerSettingsService;
    yield* settings.getSettings;
    const committed = yield* Settings.MemoryHubCommittedSettings;
    expect(yield* committed.readPublication!).toEqual({
      state: "unavailable",
      code: "invalid_settings",
    });
    expect((yield* committed.read).settings.mode).toBe("disabled");
  }).pipe(Effect.provide(fixture())),
);
