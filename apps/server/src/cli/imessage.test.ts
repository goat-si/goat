// @effect-diagnostics nodeBuiltinImport:off -- synthetic CLI settings fixture only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as ChannelIdentityService from "../channels/ChannelIdentityService.ts";
import * as ChannelLedger from "../channels/ChannelLedger.ts";
import { deliveryIdFor, linkCodeHashFor } from "../channels/channelIds.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  disableImessage,
  enableImessage,
  formatImessageStatus,
  readImessageFile,
} from "./imessage.ts";

describe("iMessage local CLI settings", () => {
  it("reports status without handles or message text", () => {
    const status = formatImessageStatus({
      enabled: true,
      mac: true,
      allowedCount: 1,
      cursor: 12,
      database: "available",
    });
    expect(status).toContain("cursor=12");
    expect(status).not.toContain("+1555");
    expect(status).not.toContain("hello");
  });
  it.effect("creates a limited code and unlinks the connected handle", () =>
    Effect.gen(function* () {
      const service = yield* ChannelIdentityService.ChannelIdentityService;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const owner = {
        ownerId: "environment:local-env",
        principalId: "local-cli",
        displayName: "Owner",
        grantedScopes: ["orchestration:operate" as const],
        runtimeModeCeiling: "approval-required" as const,
      };
      const connectionId = "imessage-000000000001";
      const link = yield* service.createLink(
        {
          connectionId,
          runtimeModeCeiling: "approval-required",
          grantedScopes: owner.grantedScopes,
          expiresInSeconds: 600,
        },
        owner,
      );
      const destination = {
        kind: "imessage" as const,
        connectionId,
        chatGuid: "iMessage;-;+15550000000",
      };
      const notice = (causeKey: string) => {
        const deliveryId = deliveryIdFor(causeKey);
        return {
          deliveryId,
          causeKey,
          message: { deliveryId, destination, kind: "receipt" as const, text: "Linked" },
        };
      };
      const consumed = yield* ledger.consumeIdentityLink({
        codeHash: linkCodeHashFor(connectionId, link.code),
        connectionId,
        externalActorId: "+15550000000",
        now: DateTime.formatIso(yield* DateTime.now),
        notice: notice("success"),
        failureNotice: notice("failure"),
      });
      expect(consumed.type).toBe("linked");
      expect(
        (yield* ledger.findIdentity({ connectionId, externalActorId: "+15550000000" }))
          ?.runtimeModeCeiling,
      ).toBe("approval-required");
      yield* service.unlink({ connectionId, externalActorId: "+15550000000" });
      expect(
        yield* ledger.findIdentity({ connectionId, externalActorId: "+15550000000" }),
      ).toBeUndefined();
    }).pipe(
      Effect.provide(
        ChannelIdentityService.layer.pipe(
          Layer.provideMerge(ChannelLedger.layer),
          Layer.provide(SqlitePersistence.layerMemory),
        ),
      ),
    ),
  );
  it("preserves connection ID and requires an explicit full-access ceiling", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-imsg-cli-"));
    try {
      const input = {
        stateDir: dir,
        environmentId: EnvironmentId.make("local-env"),
        allow: [" PERSON@Example.com "],
        own: [],
        fullAccess: false,
      };
      const first = await enableImessage(input);
      expect(first.allowedHandles).toEqual(["person@example.com"]);
      expect(first.owner).toMatchObject({
        grantedScopes: ["orchestration:operate"],
        runtimeModeCeiling: "approval-required",
        principalId: "local-cli",
      });
      const second = await enableImessage({ ...input, fullAccess: true });
      expect(second.connectionId).toBe(first.connectionId);
      expect(second.owner.runtimeModeCeiling).toBe("full-access");
      await disableImessage(dir);
      expect((await readImessageFile(dir))?.enabled).toBe(false);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects malformed handles before creating settings", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-imsg-cli-"));
    try {
      await expect(
        enableImessage({
          stateDir: dir,
          environmentId: EnvironmentId.make("local-env"),
          allow: ["12345"],
          own: [],
          fullAccess: false,
        }),
      ).rejects.toThrow("Invalid iMessage handle");
      expect(NodeFS.readdirSync(dir)).toEqual([]);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
