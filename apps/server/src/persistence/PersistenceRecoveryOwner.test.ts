import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { vi } from "vite-plus/test";
import * as PersistenceOwner from "./PersistenceRecoveryOwner.ts";

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class FailedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      if (args[1]?.eval)
        throw Object.assign(new Error("worker construction failed"), {
          code: "ERR_WORKER_INIT_FAILED",
        });
      super(...args);
    }
  }
  return { ...actual, Worker: FailedWorker };
});

it.effect.each(["retirement", "alarm"] as const)(
  "logs synchronous worker construction failure exactly once before %s exits",
  (exitPath) =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const messages: Array<string> = [];
      let alarms = 0;
      let expire: (() => void) | undefined;
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Fatal") {
          events.push("log");
          messages.push(String(message));
        }
      });
      const result = yield* PersistenceOwner.run(
        Effect.gen(function* () {
          const owner = yield* PersistenceOwner.PersistenceRecoveryOwner;
          return yield* Layer.build(
            NodeSqliteClient.layer({
              filename: ":memory:",
              writerWorker: true,
              onFatalPersistence: owner!.report,
            }),
          );
        }),
        {
          armHardExit: (alarm) => {
            alarms++;
            expire = alarm;
            if (exitPath === "alarm") alarm();
          },
          exit: (code) => events.push(`exit:${code}`),
        },
      ).pipe(
        Effect.scoped,
        Effect.exit,
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      );
      assert.isTrue(Exit.isFailure(result));
      assert.equal(alarms, 1);
      assert.deepEqual(
        events,
        exitPath === "alarm" ? ["log", "exit:80", "exit:80"] : ["log", "exit:80"],
      );
      assert.equal(messages.length, 1);
      assert.include(messages[0]!, "No uncertain operation will be replayed");
      expire!();
      assert.equal(messages.length, 1, "the alarm must not duplicate the fatal diagnostic");
    }),
);
