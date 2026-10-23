import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import { stored } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { Transaction } from "./StoreModel.ts";
import type { HubAuthority, HubMember } from "./StoreModel.ts";
import type { MemoryStoreShape } from "./StoreShape.ts";

type MemberRow = {
  space: string;
  environment: string;
  credential_digest: string;
  credential_version: number;
  status: "active" | "revoked";
  joined_at: number | null;
};
const memberFrom = (row: MemberRow): HubMember => ({
  memorySpaceId: M.MemorySpaceId.make(row.space),
  environmentId: M.EnvironmentId.make(row.environment),
  credentialDigest: row.credential_digest,
  credentialVersion: row.credential_version,
  status: row.status,
  joinedAt: row.joined_at,
});

export const makeHubMembership = (kernel: Pick<StoreKernel, "sql">) => {
  const { sql } = kernel;
  // One space-indexed roster query. The bounded pending admin partition supplies
  // confirmation state; the authority table remains active/revoked throughout install.
  const readHubMembers: MemoryStoreShape["readHubMembers"] = Effect.fn(
    "MemoryStore.readHubMembers",
  )(function* (space) {
    const rows = yield* stored(
      "hub-members",
      sql<{
        environment: string;
        credential_version: number;
        status: M.MemoryHubMemberView["status"];
        joined_at: number | null;
      }>`WITH pending AS MATERIALIZED (
        SELECT json_extract(admin_json,'$.action.environmentId') AS environment,
          json_extract(admin_json,'$.memberVersion') AS version,
          json_extract(admin_json,'$.result.view.settings.memorySpaceId') AS space
        FROM memory_outbox WHERE space='_admin' AND kind='admin' AND status='pending'
          AND json_extract(admin_json,'$.stage') IN ('activated','ready')
          AND json_extract(admin_json,'$.action.action') IN ('provisionMember','rotateMemberCredential')
      ) SELECT m.environment,m.credential_version,m.joined_at,
      CASE WHEN EXISTS (
        SELECT 1 FROM pending AS p WHERE p.environment=m.environment
          AND p.version=m.credential_version AND (p.space IS NULL OR p.space=m.space)
      ) THEN 'pending_ack' ELSE 'active' END AS status
      FROM memory_hub_members AS m WHERE m.space=${space} AND m.status='active'
      ORDER BY m.environment LIMIT ${M.MEMORY_HUB_MAX_MEMBERS}`,
    );
    return rows.map((row) => ({
      environmentId: M.EnvironmentId.make(row.environment),
      credentialVersion: row.credential_version,
      status: row.status,
      joinedAt: row.joined_at,
    }));
  });
  const readHubMember: MemoryStoreShape["readHubMember"] = Effect.fn("MemoryStore.readHubMember")(
    function* (space, environment) {
      const rows = yield* stored(
        "hub-member",
        sql<MemberRow>`SELECT * FROM memory_hub_members WHERE space=${space} AND environment=${environment}`,
      );
      return rows[0] ? memberFrom(rows[0]) : undefined;
    },
  );
  const findHubMemberByCredential: MemoryStoreShape["findHubMemberByCredential"] = Effect.fn(
    "MemoryStore.findHubMemberByCredential",
  )(function* (credentialDigest) {
    const rows = yield* stored(
      "hub-credential",
      sql<MemberRow>`SELECT * FROM memory_hub_members WHERE credential_digest=${credentialDigest}`,
    );
    return rows[0] ? memberFrom(rows[0]) : undefined;
  });
  const requireHubMemberTx: MemoryStoreShape["requireHubMemberTx"] = Effect.fn(
    "MemoryStore.requireHubMemberTx",
  )(function* (principal) {
    yield* Transaction;
    const member = yield* readHubMember(principal.memorySpaceId, principal.environmentId);
    if (
      !member ||
      member.status !== "active" ||
      member.credentialVersion !== principal.credentialVersion
    )
      return yield* new M.MemoryHubUnauthorizedError({});
    if (!principal.scopes.includes("memory:sync")) return yield* new M.MemoryHubForbiddenError({});
    return member;
  });
  const authorizeSource = Effect.fnUntraced(function* (
    authority: HubAuthority,
    space: M.MemorySpaceId,
  ) {
    yield* Transaction;
    yield* authority.reauthorize;
    const member = yield* requireHubMemberTx(authority.principal);
    if (member.memorySpaceId !== space)
      return yield* new M.MemoryHubError({ code: "space_mismatch" });
    return { member, now: yield* authority.now };
  });
  return {
    readHubMembers,
    readHubMember,
    findHubMemberByCredential,
    requireHubMemberTx,
    authorizeSource,
  };
};

export type HubMembership = ReturnType<typeof makeHubMembership>;
