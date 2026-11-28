import {
  KeybindingCommand,
  KeybindingRule,
  KeybindingsConfig,
  KeybindingsConfigError,
  MAX_KEYBINDINGS_COUNT,
} from "@goat/contracts";
import * as SharedKeybindings from "@goat/shared/keybindings";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
const KeybindingsConfigJson = Schema.fromJsonString(KeybindingsConfig);
const encodeKeybindingsConfigJson = Schema.encodeEffect(KeybindingsConfigJson);
const layerKeybindings = () => {
  return Keybindings.layer.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "goat-keybindings-test-",
        }),
      ),
    ),
  );
};

const toDetailResult = <A, R>(effect: Effect.Effect<A, KeybindingsConfigError, R>) =>
  effect.pipe(
    Effect.mapError((error) => error.detail),
    Effect.result,
  );

const writeKeybindingsConfig = (configPath: string, rules: readonly KeybindingRule[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const encoded = yield* encodeKeybindingsConfigJson(rules);
    yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
    yield* fileSystem.writeFileString(configPath, encoded);
  });

it.layer(NodeServices.layer)("inherited shortcuts", (it) => {
  it.effect("preserves sibling shortcuts when editing an inherited shortcut", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const target = { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" } as const;
      const sibling = { ...target, key: "mod+n" };
      const unrelated = { ...sibling, command: "threadPanel.toggle" } as const;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [unrelated]);

      const replacement = { ...target, key: "f8" };
      const saved = yield* keybindings.upsertKeybindingRule({
        ...replacement,
        replace: { ...target, key: "Shift+Mod+O", when: "!(terminalFocus)" },
      });
      const relevant = (rule: (typeof saved.keybindings)[number]) =>
        rule.command === target.command || rule.command === unrelated.command;
      const expected = SharedKeybindings.compileResolvedKeybindingsConfig([
        sibling,
        unrelated,
        replacement,
      ]);
      assert.deepEqual(saved.keybindings.filter(relevant), expected);

      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const snapshot = yield* keybindings.getSnapshot;
      assert.deepEqual(snapshot.keybindings.filter(relevant), expected);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("preserves sibling shortcuts when adding to an inherited command", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      yield* writeKeybindingsConfig(keybindingsConfigPath, []);

      const added = { key: "f9", command: "chat.new" } as const;
      const saved = yield* keybindings.upsertKeybindingRule(added);
      assert.deepEqual(
        saved.keybindings.filter((rule) => rule.command === added.command),
        SharedKeybindings.compileResolvedKeybindingsConfig([
          { key: "mod+n", command: added.command, when: "!terminalFocus" },
          { key: "mod+shift+o", command: added.command, when: "!terminalFocus" },
          added,
        ]),
      );
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("preserves sibling shortcuts by rejecting an edit that would evict saved rules", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const original = JSON.stringify([
        { key: "f7", command: "terminal.new" },
        ...Array.from({ length: MAX_KEYBINDINGS_COUNT - 2 }, (_, index) => ({
          key: "f1",
          command: `future.command-${index}`,
        })),
      ]);
      yield* fs.writeFileString(keybindingsConfigPath, original);

      const target = { key: "mod+n", command: "chat.new", when: "!terminalFocus" } as const;
      const result = yield* toDetailResult(
        keybindings.upsertKeybindingRule({ ...target, key: "f8", replace: target }),
      );
      assertFailure(result, "Not enough room to save this shortcut and its inherited shortcuts.");
      assert.equal(yield* fs.readFileString(keybindingsConfigPath), original);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("preserves sibling shortcuts only if visible within the binding limit", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      yield* writeKeybindingsConfig(
        keybindingsConfigPath,
        Array.from({ length: 209 }, (_, index) => ({
          key: "mod+alt+f1",
          command: `script.filler-${index}.run` as const,
        })),
      );

      const target = { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" } as const;
      const local = { ...target, key: "mod+shift+n", command: "chat.newLocal" } as const;
      const relevant = (rule: { readonly command: KeybindingCommand }) =>
        rule.command === target.command || rule.command === local.command;
      const before = yield* keybindings.getSnapshot;
      assert.deepEqual(
        before.keybindings.filter(relevant),
        SharedKeybindings.compileResolvedKeybindingsConfig([target, local]),
      );

      const replacement = { ...target, key: "f8" };
      const saved = yield* keybindings.upsertKeybindingRule({ ...replacement, replace: target });
      assert.deepEqual(
        saved.keybindings.filter(relevant),
        SharedKeybindings.compileResolvedKeybindingsConfig([local, replacement]),
      );
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect(
    "preserves sibling shortcuts when an inherited edit target has since become hidden",
    () =>
      Effect.gen(function* () {
        const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
        const keybindings = yield* Keybindings.Keybindings;
        yield* writeKeybindingsConfig(
          keybindingsConfigPath,
          Array.from({ length: 208 }, (_, index) => ({
            key: "mod+alt+f1",
            command: `script.filler-${index}.run` as const,
          })),
        );

        const target = { key: "mod+n", command: "chat.new", when: "!terminalFocus" } as const;
        const sibling = { ...target, key: "mod+shift+o" };
        const isChatNew = (binding: { readonly command: KeybindingCommand }) =>
          binding.command === target.command;
        const before = yield* keybindings.getSnapshot;
        assert.deepEqual(
          before.keybindings.filter(isChatNew),
          SharedKeybindings.compileResolvedKeybindingsConfig([target, sibling]),
        );

        const afterUnrelatedSave = yield* keybindings.upsertKeybindingRule({
          key: "mod+alt+f1",
          command: "script.extra.run",
        });
        assert.deepEqual(
          afterUnrelatedSave.keybindings.filter(isChatNew),
          SharedKeybindings.compileResolvedKeybindingsConfig([sibling]),
        );

        const replacement = { ...target, key: "f8" };
        const saved = yield* keybindings.upsertKeybindingRule({ ...replacement, replace: target });
        assert.deepEqual(
          saved.keybindings.filter(isChatNew),
          SharedKeybindings.compileResolvedKeybindingsConfig([sibling, replacement]),
        );
      }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("unassigns a shortcut without restoring it on startup and can reassign it", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, []);
      const keybindings = yield* Keybindings.Keybindings;
      const target = SharedKeybindings.DEFAULT_KEYBINDINGS.find(
        (rule) => rule.command === "composer.sendBackground",
      )!;
      const siblings = SharedKeybindings.DEFAULT_KEYBINDINGS.filter(
        (rule) => rule.command === target.command && rule !== target,
      );
      const removed = yield* keybindings.upsertKeybindingRule({
        ...target,
        when: "false",
        replace: target,
      });
      const expected = SharedKeybindings.compileResolvedKeybindingsConfig([
        ...siblings,
        { ...target, when: "false" },
      ]);
      assert.deepEqual(
        removed.keybindings.filter((rule) => rule.command === target.command),
        expected,
      );
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const snapshot = yield* keybindings.getSnapshot;
      assert.deepEqual(
        snapshot.keybindings.filter((rule) => rule.command === target.command),
        expected,
      );
      const restored = yield* keybindings.upsertKeybindingRule({
        ...target,
        replace: { ...target, when: "false" },
      });
      assert.deepEqual(
        restored.keybindings.filter((rule) => rule.command === target.command),
        SharedKeybindings.compileResolvedKeybindingsConfig([...siblings, target]),
      );
    }).pipe(Effect.provide(layerKeybindings())),
  );
});
