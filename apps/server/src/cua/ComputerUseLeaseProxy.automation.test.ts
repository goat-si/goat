import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { active, call, harness } from "./ComputerUseLeaseProxy.testkit.ts";

const appsResult = {
  content: [{ type: "text", text: "2 apps" }],
  structuredContent: {
    apps: [
      { pid: 42, bundle_id: "com.apple.TextEdit", name: "TextEdit" },
      { pid: 43, bundle_id: "com.apple.finder", name: "Finder" },
      // An app without a bundle id is listed by its name, which can look like one.
      { pid: 44, name: "Acme.Editor" },
    ],
  },
};
const apps = (id: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result: appsResult });

// invoke_menu's background save through Apple Events (driver tools/invoke_menu.rs).
const saveRefused = (
  id: number,
  cause: string,
  reason = "macOS does not allow Cua Driver to control TextEdit",
) => {
  const message =
    "File > Save is disabled while TextEdit is in the background, and saving through TextEdit's scripting interface did not complete (" +
    cause +
    ": " +
    reason +
    "). Nothing was saved. invoke_menu does not activate a background app.";
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: message }],
      structuredContent: {
        status: "refused",
        code: "background_unavailable",
        refusal: { code: "background_unavailable", message },
      },
      isError: true,
    },
  });
};

// set_value's Finder rename through Apple Events (driver tools/set_value.rs).
const renameRefused = (id: number, cause: string, pid = 43) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: "set_value refused (file_name_needs_rename): " + cause }],
      structuredContent: {
        code: "file_name_needs_rename",
        effect: "refused",
        path: "apple_events",
        pid,
        window_id: 9,
        reason: "x",
        cause,
      },
      isError: true,
    },
  });

interface Reply {
  readonly result: {
    readonly content: ReadonlyArray<{ readonly text?: string }>;
    readonly structuredContent: Record<string, unknown>;
  };
}

const listApps = Effect.fn(function* (h: Effect.Success<ReturnType<typeof harness>>) {
  yield* h.push(active());
  yield* h.send(call(1, "list_apps"));
  yield* h.nextToDriver;
  yield* h.reply(apps(1));
  yield* h.nextToProvider;
});

const save = call(2, "invoke_menu", { pid: 42, window_id: 7, path: ["File", "Save"] });
const rename = call(2, "set_value", {
  target: { kind: "window", pid: 43, window_id: 9 },
  element_index: 3,
  value: "b",
});
// The driver resolves an element token to its window without a pid in the call.
const tokenRename = call(2, "set_value", { element_token: "s1:3", value: "b" });

describe("lease proxy macOS Automation refusals", () => {
  it.effect(
    "tells the agent which app macOS has not let GOAT Computer Use control, as permissionsNotGranted",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ automationHolder: "helper" });
        yield* listApps(h);
        yield* h.send(save);
        yield* h.nextToDriver;
        yield* h.reply(saveRefused(2, "automation_denied"));
        const reply = (yield* h.nextToProvider) as unknown as Reply;
        const structured = reply.result.structuredContent;
        assert.equal(structured.refused, "permissionsNotGranted");
        assert.equal(structured.detail, "automation_not_allowed");
        assert.equal(structured.app, "com.apple.TextEdit");
        assert.deepEqual(structured.block, {
          reason: "permissionsNotGranted",
          missing: ["automation"],
          holder: "helper",
          target: "com.apple.TextEdit",
        });
        // The driver's own answer still reaches the agent.
        assert.equal(structured.code, "background_unavailable");
        const note = reply.result.content.at(-1)?.text ?? "";
        assert.include(note, "GOAT Computer Use to control com.apple.TextEdit");
        assert.include(note, "Automation");
      }),
  );

  it.effect(
    "lists the apps before an Apple Events call it cannot tie to an app, so the refusal names it",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ automationHolder: "app" });
        // A whole-desktop control never lists apps for its scope.
        yield* h.push(active());
        yield* h.send(tokenRename);
        const lookup = yield* h.nextToDriver;
        assert.deepEqual(lookup.params, { name: "list_apps", arguments: {} });
        yield* h.reply(apps(lookup.id));
        assert.equal((yield* h.nextToDriver).id, 2);
        yield* h.reply(renameRefused(2, "automation_timeout"));
        const reply = (yield* h.nextToProvider) as unknown as Reply;
        const structured = reply.result.structuredContent;
        assert.equal(structured.refused, "permissionsPending");
        assert.equal(structured.detail, "automation_pending");
        assert.equal(structured.app, "com.apple.finder");
        assert.deepEqual(structured.block, {
          reason: "permissionsNotGranted",
          missing: ["automation"],
          holder: "app",
          target: "com.apple.finder",
        });
        // In development GOAT itself sends the Apple Events; a timeout only suggests a prompt.
        const note = reply.result.content.at(-1)?.text ?? "";
        assert.include(note, "Automation prompt for GOAT on this Mac");
        assert.notInclude(note, "has not allowed");
      }),
  );

  it.effect("never names an app by a listed display name that only looks like a bundle id", () =>
    Effect.gen(function* () {
      const h = yield* harness({ automationHolder: "helper" });
      yield* listApps(h);
      yield* h.send(call(2, "set_value", { pid: 44, window_id: 9, element_index: 3, value: "b" }));
      yield* h.nextToDriver;
      yield* h.reply(renameRefused(2, "automation_denied", 44));
      const structured = ((yield* h.nextToProvider) as unknown as Reply).result.structuredContent;
      assert.equal(structured.refused, "permissionsNotGranted");
      assert.notProperty(structured, "app");
      assert.deepEqual(structured.block, {
        reason: "permissionsNotGranted",
        missing: ["automation"],
        holder: "helper",
      });
    }),
  );

  it.effect(
    "leaves Apple Event failures that are not about consent, and hosts without Automation, as the driver said",
    () =>
      Effect.gen(function* () {
        const failed = yield* harness({ automationHolder: "helper" });
        yield* listApps(failed);
        yield* failed.send(rename);
        yield* failed.nextToDriver;
        yield* failed.reply(renameRefused(2, "automation_failed"));
        assert.deepEqual(
          yield* failed.nextToProvider,
          JSON.parse(renameRefused(2, "automation_failed")),
        );
        // A document path inside another cause's reason does not pass for a consent code.
        const tricky = saveRefused(
          3,
          "automation_failed",
          "TextEdit lists no open document for /tmp/(automation_denied: x).rtf",
        );
        yield* failed.send(
          call(3, "invoke_menu", { pid: 42, window_id: 7, path: ["File", "Save"] }),
        );
        yield* failed.nextToDriver;
        yield* failed.reply(tricky);
        assert.deepEqual(yield* failed.nextToProvider, JSON.parse(tricky));

        const elsewhere = yield* harness();
        yield* listApps(elsewhere);
        yield* elsewhere.send(save);
        yield* elsewhere.nextToDriver;
        yield* elsewhere.reply(saveRefused(2, "automation_denied"));
        assert.deepEqual(
          yield* elsewhere.nextToProvider,
          JSON.parse(saveRefused(2, "automation_denied")),
        );
      }),
  );
});
