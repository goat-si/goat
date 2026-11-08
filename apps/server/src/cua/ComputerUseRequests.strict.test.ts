import { assert, it } from "@effect/vitest";
import { CommandId, MessageId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  cuaRequestableApps,
  cuaRequestableCatalog,
  type CuaDriverListedApp,
} from "@goat/shared/cuaDriverManifest";

import { threadId, withHarness } from "../handoffs/Handoffs.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import { supported, withRequests } from "./ComputerUseRequests.testkit.ts";

it.effect("without strict input guards a named protected app is admitted without a handoff", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("named-protected-off"),
        threadId,
        messageId: MessageId.make("message:named-protected-off"),
        text: "Use com.1password.safari",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* withRequests(orchestrator, supported, ({ request }) =>
        Effect.gen(function* () {
          yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
            cuaStrictInputGuards: false,
          });
          assert.equal((yield* request({ apps: ["com.1password.safari"] })).kind, "available");
          const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
          assert.isFalse(records.turnItems.some((item) => item.type === "human_handoff"));
        }),
      );
    }),
  ),
);

// What a host lists without strict input guards: protected apps keep their ids and names.
const LISTED: ReadonlyArray<CuaDriverListedApp> = [
  { bundle_id: "com.example.Editor", name: "Editor" },
  { bundle_id: "com.apple.Passwords", name: "Passwords" },
  { name: "1Password", executable: "C:\\Apps\\1Password.exe" },
];
const loose = { includeProtected: true };
// The harness arguments after the test body: that listing and its catalog.
const looseListing = [
  undefined,
  undefined,
  undefined,
  Option.some(cuaRequestableApps(LISTED, [], loose)),
  undefined,
  "person",
  undefined,
  cuaRequestableCatalog(LISTED, [], loose),
] as const;

it.effect.each(["com.apple.Passwords", "1Password", "C:\\Apps\\1Password.exe"])(
  "without strict input guards a listed protected app id or name is admitted (%s)",
  (app) =>
    withHarness(({ orchestrator }) =>
      withRequests(
        orchestrator,
        supported,
        ({ request }) =>
          Effect.gen(function* () {
            yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
              cuaStrictInputGuards: false,
            });
            assert.equal((yield* request({ apps: [app] })).kind, "available");
          }),
        ...looseListing,
      ),
    ),
);

it.effect(
  "without strict input guards a person naming a protected app by display name counts",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("display-named"),
          threadId,
          messageId: MessageId.make("message:display-named"),
          text: "Use Passwords",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* withRequests(
          orchestrator,
          supported,
          ({ request }) =>
            Effect.gen(function* () {
              yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
                cuaStrictInputGuards: false,
              });
              assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
              assert.equal((yield* request({ apps: ["com.apple.Passwords"] })).kind, "available");
              assert.equal((yield* request({ apps: ["com.example.Missing"] })).kind, "refused");
              const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
              assert.isFalse(records.turnItems.some((item) => item.type === "human_handoff"));
            }),
          ...looseListing,
        );
      }),
    ),
);
