import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { cuaDriverKey } from "@goat/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../persistence/Migrations.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { grant } from "./ComputerUseLeases.projection.testkit.ts";
import {
  prepareThreadAttachment,
  threadAttachmentLayer,
  threadDriver,
} from "./ComputerUseAttachment.thread.testkit.ts";

const config = {
  environmentId: EnvironmentId.make("fixture"),
  threadId: ThreadId.make("thread:stable-proxy"),
  providerSessionId: "fixture-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer fixture-lease-secret",
  browserToolsAvailable: false,
};

describe("thread computer use launch identity", () => {
  it.effect("keeps the issued descriptor identical across Stop and a new approval", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      yield* grant(config.threadId, "handoff:first", ["fixture.calculator"]);
      const first = yield* prepareThreadAttachment(config);
      yield* leases.stop(config.threadId);
      assert.deepEqual(
        yield* leases.controlState(config.threadId, first.attachment.control.controlId),
        { _tag: "ended", reason: "stopped" },
      );
      yield* TestClock.adjust("1 minute");
      yield* grant(config.threadId, "handoff:second", ["fixture.calculator"]);
      const next = yield* prepareThreadAttachment(config);
      assert.notEqual(next.attachment.control.controlId, first.attachment.control.controlId);
      assert.deepEqual(next.descriptor, first.descriptor);
      assert.equal(cuaDriverKey(next.descriptor), cuaDriverKey(first.descriptor));
      assert.deepEqual(first.descriptor.args.slice(0, 4), [
        "/fixture/goat.mjs",
        "cua-lease-proxy",
        "--thread",
        config.threadId,
      ]);
    }).pipe(Effect.provide(threadAttachmentLayer)),
  );

  it.effect("changes the key for a real driver, socket or non-secret display change", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const first = yield* prepareThreadAttachment(config);
      for (const mcp of [
        { ...threadDriver, command: "/fixture/new-driver" },
        { ...threadDriver, args: [...threadDriver.args, "--new-driver-option"] },
        { ...threadDriver, socketPath: "/tmp/new-cua.sock" },
        { ...threadDriver, environment: [{ name: "DISPLAY", value: ":8" }] },
      ]) {
        const next = yield* prepareThreadAttachment(config, mcp);
        assert.notDeepEqual(next.descriptor.args, first.descriptor.args);
        assert.notEqual(cuaDriverKey(next.descriptor), cuaDriverKey(first.descriptor));
      }
      const display = yield* prepareThreadAttachment(config, threadDriver, { DISPLAY: ":9" });
      assert.notEqual(cuaDriverKey(display.descriptor), cuaDriverKey(first.descriptor));
    }).pipe(Effect.provide(threadAttachmentLayer)),
  );

  it.effect(
    "excludes credentials and arbitrary driver environment from the launch fingerprint",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const first = yield* prepareThreadAttachment(config);
        const next = yield* prepareThreadAttachment(
          { ...config, authorizationHeader: "Bearer fixture-rotated-secret" },
          {
            ...threadDriver,
            environment: [
              { name: "API_KEY", value: "fixture-driver-secret" },
              { name: "GOAT_CUA_LEASE_AUTHORIZATION", value: "fixture-nested-secret" },
              ...threadDriver.environment,
            ],
          },
        );
        assert.equal(cuaDriverKey(next.descriptor), cuaDriverKey(first.descriptor));
        assert.deepEqual(next.descriptor.args, first.descriptor.args);
        const index = first.descriptor.args.indexOf("--driver-fingerprint");
        assert.isAtLeast(index, 0);
        assert.match(first.descriptor.args[index + 1] ?? "", /^[a-f0-9]{64}$/);
        assert.deepInclude(next.descriptor.environment, {
          name: "GOAT_CUA_LEASE_AUTHORIZATION",
          value: "Bearer fixture-rotated-secret",
        });
      }).pipe(Effect.provide(threadAttachmentLayer)),
  );
});
