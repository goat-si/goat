import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { GOAT_PROJECT_FILE_NAME, type GoatProjectFile } from "@goat/contracts";
import { LEGACY_PROJECT_FILE_NAME } from "@goat/contracts/legacyT3Names";
import { GoatProjectFileFromJson } from "@goat/shared/goatProjectFile";

const decodeGoatProjectFileJson = Schema.decodeEffect(GoatProjectFileFromJson);

export class GoatProjectFileLoadError extends Schema.TaggedError<GoatProjectFileLoadError>()(
  "GoatProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const fileName = this.filePath.endsWith(LEGACY_PROJECT_FILE_NAME)
      ? LEGACY_PROJECT_FILE_NAME
      : GOAT_PROJECT_FILE_NAME;
    return `Failed to ${this.operation} ${fileName} at ${this.filePath}.`;
  }
}

export class GoatProjectFileLoader extends Context.Service<
  GoatProjectFileLoader,
  {
    /** Never fails; missing/unreadable/invalid files return none, with warnings for invalid files. */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<GoatProjectFile>>;
  }
>()("goat/project/GoatProjectFileLoader") {}

const logGoatProjectFileLoadError = (error: GoatProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: GoatProjectFileLoader["Service"]["load"] = Effect.fn("GoatProjectFileLoader.load")(
    function* (workspaceRoot) {
      let filePath = path.join(workspaceRoot, GOAT_PROJECT_FILE_NAME);
      const raw = yield* fileSystem.readFileString(filePath).pipe(
        Effect.catchTags({
          PlatformError: (error) => {
            if (error.reason._tag !== "NotFound") return Effect.fail(error);
            filePath = path.join(workspaceRoot, LEGACY_PROJECT_FILE_NAME);
            return fileSystem.readFileString(filePath);
          },
        }),
        Effect.asSome,
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<string>())
              : logGoatProjectFileLoadError(
                  new GoatProjectFileLoadError({
                    operation: "read",
                    workspaceRoot,
                    filePath,
                    cause: error,
                  }),
                ).pipe(Effect.as(Option.none<string>())),
        }),
      );
      if (Option.isNone(raw)) {
        return Option.none<GoatProjectFile>();
      }
      return yield* decodeGoatProjectFileJson(raw.value).pipe(
        Effect.asSome,
        Effect.catchTags({
          SchemaError: (error) =>
            logGoatProjectFileLoadError(
              new GoatProjectFileLoadError({
                operation: "decode",
                workspaceRoot,
                filePath,
                cause: error,
              }),
            ).pipe(Effect.as(Option.none<GoatProjectFile>())),
        }),
      );
    },
  );

  return GoatProjectFileLoader.of({ load });
});

export const layer = Layer.effect(GoatProjectFileLoader, make);
