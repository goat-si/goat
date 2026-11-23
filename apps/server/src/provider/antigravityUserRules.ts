import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const ruleFiles = ["AGENTS.md", "GEMINI.md"] as const;

const RuleCopiesJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const decodeRuleCopies = Schema.decodeUnknownOption(RuleCopiesJson);
const encodeRuleCopies = Schema.encodeSync(RuleCopiesJson);

/** Copies refresh each launch; the recorded copy keeps a file the profile owns or edited untouched. */
export const copyAntigravityUserRuleFiles = Effect.fn("copyAntigravityUserRuleFiles")(
  function* (input: {
    readonly profileDirectory: string;
    readonly sourceDirectory: string;
  }): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifestPath = path.join(input.profileDirectory, ".goat-rule-copies.json");
    const readOptional = (file: string) =>
      fs.readFileString(file).pipe(Effect.orElseSucceed((): string | undefined => undefined));
    const manifestText = yield* readOptional(manifestPath);
    const copies: Record<string, string> = {
      ...Option.getOrElse(decodeRuleCopies(manifestText), () => ({})),
    };
    for (const name of ruleFiles) {
      const link = path.join(input.profileDirectory, name);
      const target = path.join(input.sourceDirectory, name);
      yield* Effect.gen(function* () {
        const current = yield* readOptional(link);
        if (current !== undefined && current !== copies[name]) {
          delete copies[name];
          return;
        }
        const source = yield* readOptional(target);
        if (source === undefined) {
          if (current !== undefined) yield* fs.remove(link);
          delete copies[name];
          return;
        }
        yield* fs.writeFileString(link, source);
        copies[name] = source;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Antigravity user rules are not copied into the profile.", {
            link,
            target,
            error,
          }),
        ),
      );
    }
    yield* fs
      .writeFileString(manifestPath, encodeRuleCopies(copies))
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Antigravity rule copy record could not be written.", { error }),
        ),
      );
  },
);

export const linkAntigravityUserRuleFiles = Effect.fn("linkAntigravityUserRuleFiles")(
  function* (input: { readonly profileDirectory: string; readonly sourceDirectory: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const name of ruleFiles) {
      const link = path.join(input.profileDirectory, name);
      const target = path.join(input.sourceDirectory, name);
      yield* Effect.gen(function* () {
        const existing = yield* fs.readLink(link).pipe(Effect.option);
        if (Option.isSome(existing)) {
          const resolved = path.resolve(path.dirname(link), existing.value);
          if (resolved !== target) return;
          if (!(yield* fs.exists(target))) yield* fs.remove(link);
          return;
        }
        if ((yield* fs.exists(link)) || !(yield* fs.exists(target))) return;
        yield* fs.symlink(target, link);
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning("Antigravity user rule could not be linked.", { link }),
        ),
      );
    }
  },
);
