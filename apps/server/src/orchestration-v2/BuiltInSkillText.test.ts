import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ServerSettings,
  ServerSettingsError,
  ThreadId,
} from "@goat/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";

import { planClaudeSkillDispatch } from "../provider/Drivers/ClaudeSkillDispatch.ts";
import { builtInSkillProviderText } from "./BuiltInSkillText.ts";
import { ProjectionStoreThreadNotFoundError } from "./ProjectionStore.ts";

const ordinary = ProjectId.make("ordinary");
const optedOut = ProjectId.make("opted-out");
const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  projectSettingsOverrides: {
    [optedOut]: { builtInSkills: { "goat-discipline": { enabled: false } } },
  },
};
const serving = Option.some({ getSettings: Effect.succeed(settings) });
const BLOCK = '<goat_skill name="goat-discipline">';
const blocks = (text: string) => text.split(BLOCK).length - 1;
const send = (
  text: string,
  options: {
    readonly driver?: string;
    readonly project?: ProjectId | null;
    readonly settings?: Parameters<typeof builtInSkillProviderText>[0];
  } = {},
) =>
  builtInSkillProviderText(options.settings ?? serving, {
    message: { text },
    driver: options.driver ?? "codex",
    project: Effect.succeed(options.project === undefined ? ordinary : options.project),
  });

describe("goat-discipline delivery to the provider", () => {
  it.effect(
    "reaches every provider that carries GOAT instructions only when the message names it",
    () =>
      Effect.gen(function* () {
        for (const driver of [
          "codex",
          "claudeAgent",
          "cursor",
          "grok",
          "antigravity",
          "acpRegistry",
          "opencode",
          "pi",
        ]) {
          expect(blocks(yield* send("Plan it $goat-discipline", { driver }))).toBe(1);
          expect(yield* send("Plan it", { driver })).toBe("Plan it");
        }
        for (const driver of ["muse", "devinCloud"]) {
          expect(yield* send("Plan it $goat-discipline", { driver })).toBe(
            "Plan it $goat-discipline",
          );
        }
      }),
  );

  it.effect("leaves a project that switched it off without the guidance", () =>
    Effect.gen(function* () {
      expect(blocks(yield* send("Plan $goat-discipline", { project: optedOut }))).toBe(0);
      expect(blocks(yield* send("Plan $goat-discipline", { project: null }))).toBe(1);
    }),
  );

  it.effect(
    "delivers nothing when the settings cannot be read, so an opt-out is never skipped",
    () =>
      Effect.gen(function* () {
        expect(yield* send("Plan $goat-discipline", { settings: Option.none() })).toBe(
          "Plan $goat-discipline",
        );
        const failing = Option.some({
          getSettings: Effect.fail(
            new ServerSettingsError({ settingsPath: "settings.json", operation: "read-file" }),
          ),
        });
        expect(yield* send("Plan $goat-discipline", { settings: failing })).toBe(
          "Plan $goat-discipline",
        );
        const projectUnknown = builtInSkillProviderText(serving, {
          message: { text: "Plan $goat-discipline" },
          driver: "codex",
          project: Effect.fail(
            new ProjectionStoreThreadNotFoundError({ threadId: ThreadId.make("thread-gone") }),
          ),
        });
        expect(yield* projectUnknown).toBe("Plan $goat-discipline");
      }),
  );

  it.effect("gives Claude the guidance once beside its own skills, a same-name one included", () =>
    Effect.gen(function* () {
      for (const native of ["review", "goat-discipline"]) {
        const text = yield* send(`$goat-discipline then $${native} the diff`, {
          driver: "claudeAgent",
        });
        const dispatch = planClaudeSkillDispatch(
          text,
          new Map([[native, { path: `/repo/.claude/skills/${native}/SKILL.md` }]]),
        );
        expect(dispatch?.skillName).toBe(native);
        expect(blocks(`${dispatch?.leadingText ?? ""}\n${dispatch?.commandText ?? ""}`)).toBe(1);
      }
    }),
  );

  it.effect("leaves a native command first and without the guidance", () =>
    Effect.gen(function* () {
      expect(yield* send("/review $goat-discipline", { driver: "claudeAgent" })).toBe(
        "/review $goat-discipline",
      );
    }),
  );
});
