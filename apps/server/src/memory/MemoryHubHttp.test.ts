import lineageMigration from "../persistence/Migrations/080_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/081_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/093_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/082_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/083_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/084_MemoryRevertResults.ts";
import { expect, it } from "vite-plus/test";
import * as M from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Store from "./MemoryStore.ts";
import * as Auth from "./MemoryHubAuth.ts";
import * as Hub from "./MemoryHubHttp.ts";
import * as Settings from "../serverSettings.ts";
import migration from "../persistence/Migrations/076_Memory.ts";
import hubMigration from "../persistence/Migrations/077_MemoryHubSync.ts";

const space = M.MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
const member = M.EnvironmentId.make("synthetic-member");
const credential = "d".repeat(43);
const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* migration;
    yield* hubMigration;
    yield* lineageMigration;
    yield* checkpointMigration;
    yield* revisionSizeMigration;
    yield* reportMigration;
    yield* usageMigration;
    yield* revertMigration;
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const digest = Hex.encode(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(credential)),
    );
    yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${member},${digest},1,'active',0)`;
  }),
).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  Layer.provideMerge(NodeServices.layer),
);
const auth = Auth.layer.pipe(Layer.provideMerge(Store.layer.pipe(Layer.provideMerge(setup))));

// L2 is an independently implemented boundary. These transport tests keep real auth,
// membership and settings, and inject only the absent L2 service implementation.
const boundary = (failure?: Hub.HubFailure) =>
  Layer.effect(
    Hub.MemoryHubService,
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const auth = yield* Auth.MemoryHubAuth;
      return Hub.MemoryHubService.of({
        join: () => Effect.fail(failure ?? new M.MemoryHubError({ code: "bootstrap_required" })),
        push: (input, principal) =>
          store
            .transact(
              Effect.gen(function* () {
                yield* auth.reauthorize(principal);
                if (input.environmentId !== principal.environmentId)
                  return yield* new M.MemoryHubForbiddenError({});
                if (failure) return yield* failure;
                return { receipts: [] };
              }),
            )
            .pipe(
              Effect.mapError((error) =>
                error._tag === "MemoryStorageError"
                  ? new M.MemoryHubError({ code: "storage_failed" })
                  : error,
              ),
            ),
        pull: () => Effect.fail(failure ?? new M.MemoryHubError({ code: "bootstrap_required" })),
        claim: () => Effect.fail(failure ?? new M.MemoryHubError({ code: "claim_busy" })),
        renew: () => Effect.fail(failure ?? new M.MemoryHubError({ code: "lease_expired" })),
        applyResolution: () => Effect.fail(failure ?? new M.MemoryHubError({ code: "fenced" })),
        release: () => Effect.succeed({ released: false }),
        requestSourceRead: () => Effect.fail(new M.MemoryHubForbiddenError({})),
        collectSourceReads: () => Effect.succeed({ requests: [] }),
        respondSourceRead: () => Effect.fail(new M.MemoryHubForbiddenError({})),
        resultSourceRead: () => Effect.fail(new M.MemoryHubForbiddenError({})),
      });
    }),
  ).pipe(Layer.provideMerge(auth));
const app = (failure?: Hub.HubFailure, disabled = false) =>
  Hub.layer.pipe(
    Layer.provideMerge(boundary(failure)),
    Layer.provideMerge(
      Settings.layerTest(
        {
          memoryHub: disabled ? { mode: "disabled" } : { mode: "hub", memorySpaceId: space },
        },
        "memoryHub",
      ),
    ),
  );
const request = (
  path: string,
  body: unknown,
  authorization: string | null = `Bearer ${credential}`,
) =>
  new Request(`https://hub.invalid${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "browser=foreign-admin",
      ...(authorization === null ? {} : { authorization }),
    },
    body: JSON.stringify(body),
  });

it("all eleven registered POST routes reject invalid envelopes after bearer auth", async () => {
  const { handler, dispose } = HttpRouter.toWebHandler(app(), { disableLogger: true });
  try {
    for (const path of Object.values(M.MEMORY_HUB_PATHS)) {
      const response = await handler(request(path, { invalid: true }), Context.empty());
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  } finally {
    await dispose();
  }
});

it("a foreign admin cookie neither replaces nor broadens bearer identity", async () => {
  const { handler, dispose } = HttpRouter.toWebHandler(app(), { disableLogger: true });
  try {
    const body = {
      protocolVersion: 1,
      memorySpaceId: space,
      environmentId: member,
      operations: [],
    };
    const accepted = await handler(request(M.MEMORY_HUB_PATHS.push, body), Context.empty());
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ receipts: [] });
    const denied = await handler(
      request(M.MEMORY_HUB_PATHS.push, { ...body, environmentId: "cookie-owner" }),
      Context.empty(),
    );
    expect(denied.status).toBe(403);
    const cookieOnly = await handler(request(M.MEMORY_HUB_PATHS.push, body, null), Context.empty());
    expect(cookieOnly.status).toBe(401);
  } finally {
    await dispose();
  }
});

it.each([
  [new M.MemoryHubUnauthorizedError({}), 401],
  [new M.MemoryHubForbiddenError({}), 403],
  [new M.MemoryHubError({ code: "unsupported_protocol" }), 426],
  [new M.MemoryHubError({ code: "hub_disabled" }), 503],
  [new M.MemoryHubError({ code: "payload_too_large" }), 413],
  [new Store.MemoryStoreConflict({ code: "unsupported_protocol" }), 426],
  [new Store.MemoryStoreConflict({ code: "lease_expired" }), 409],
] as const)("maps service %s to %i without private error details", async (error, status) => {
  const { handler, dispose } = HttpRouter.toWebHandler(app(error), { disableLogger: true });
  try {
    const response = await handler(
      request(M.MEMORY_HUB_PATHS.push, {
        protocolVersion: 1,
        memorySpaceId: space,
        environmentId: member,
        operations: [],
      }),
      Context.empty(),
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const safe = await response.text();
    expect(safe).not.toContain(credential);
    if (error._tag === "MemoryStoreConflict") expect(JSON.parse(safe).code).toBe(error.code);
  } finally {
    await dispose();
  }
});

it("disabled hub, future protocol, excess keys and streamed oversize have safe statuses", async () => {
  const active = HttpRouter.toWebHandler(app(), { disableLogger: true });
  const disabled = HttpRouter.toWebHandler(app(undefined, true), { disableLogger: true });
  try {
    expect(
      (await disabled.handler(request(M.MEMORY_HUB_PATHS.push, {}), Context.empty())).status,
    ).toBe(503);
    expect(
      (
        await active.handler(
          request(M.MEMORY_HUB_PATHS.push, { protocolVersion: 2 }),
          Context.empty(),
        )
      ).status,
    ).toBe(426);
    expect(
      (
        await active.handler(
          request(M.MEMORY_HUB_PATHS.push, {
            protocolVersion: 1,
            memorySpaceId: space,
            environmentId: member,
            operations: [],
            credential,
          }),
          Context.empty(),
        )
      ).status,
    ).toBe(400);
    expect(
      (await active.handler(request(M.MEMORY_HUB_PATHS.push, "x".repeat(1048576)), Context.empty()))
        .status,
    ).toBe(413);
  } finally {
    await active.dispose();
    await disabled.dispose();
  }
});

it("malformed UTF-8 inside a JSON envelope is refused before service work", async () => {
  const { handler, dispose } = HttpRouter.toWebHandler(app(), { disableLogger: true });
  try {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        protocolVersion: 1,
        memorySpaceId: space,
        environmentId: member,
        operations: [],
      }),
    );
    const marker = new TextEncoder().encode(member)[0]!;
    const position = bytes.lastIndexOf(marker);
    bytes[position] = 255;
    const response = await handler(
      new Request(`https://hub.invalid${M.MEMORY_HUB_PATHS.push}`, {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: bytes,
      }),
      Context.empty(),
    );
    expect(response.status).toBe(400);
  } finally {
    await dispose();
  }
});
