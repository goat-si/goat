// @effect-diagnostics nodeBuiltinImport:off -- bounded, no-follow staging and inode-checked rollback.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  EnvironmentThemeId,
  EnvironmentThemeFile,
  environmentThemeFileHasColors,
  ServerSettingsError,
} from "@goat/contracts";
import { sanitizeThemeCss } from "@goat/shared/themeCssSanitizer";
import { BUILT_IN_THEME_IDS, UNPUBLISHABLE_THEME_IDS } from "@goat/shared/themePalettes";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "./config.ts";
import {
  acquireThemePublishLock,
  MAX_THEME_FILE_BYTES,
  MAX_THEME_FILES,
  readPublishedThemes,
  readThemeFileGuarded,
} from "./environmentTheme.ts";
import * as Settings from "./serverSettings.ts";
import { MAX_THEME_DIRECTORY_ENTRIES } from "./themeDirectory.ts";

const isThemeId = Schema.is(EnvironmentThemeId);
const encodeTheme = Schema.encodeSync(Schema.fromJsonString(EnvironmentThemeFile));

function cleanupStagingAfterFailure(path: string, original: unknown): never {
  try {
    NodeFS.unlinkSync(path);
  } catch (cleanup) {
    if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AggregateError([original, cleanup], "Theme staging cleanup failed.", {
        cause: cleanup,
      });
    }
  }
  throw original;
}

function createStaging(path: string, contents: string): number {
  const fd = NodeFS.openSync(path, "wx", 0o600);
  let open = true;
  try {
    NodeFS.writeFileSync(fd, contents);
    const inode = NodeFS.fstatSync(fd).ino;
    NodeFS.closeSync(fd);
    open = false;
    return inode;
  } catch (cause) {
    let failure = cause;
    if (open) {
      try {
        NodeFS.closeSync(fd);
      } catch (closeError) {
        failure = new AggregateError([cause, closeError], "Theme staging close failed.");
      }
    }
    return cleanupStagingAfterFailure(path, failure);
  }
}

export class ThemePublicationError extends Schema.TaggedError<ThemePublicationError>()(
  "ThemePublicationError",
  {
    message: Schema.String,
    reason: Schema.optional(Schema.Literals(["invalid", "denied"])),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

type SetInput = {
  readonly themeId?: string;
  readonly appearance?: string;
  readonly theme?: EnvironmentThemeFile;
  readonly agent: boolean;
};
export class ThemePublicationService extends Context.Service<
  ThemePublicationService,
  {
    readonly set: (
      input: SetInput,
      authorize: Effect.Effect<void, ServerSettingsError>,
    ) => Effect.Effect<void, ThemePublicationError>;
  }
>()("goat/themePublication/ThemePublicationService") {}

const invalid = (message: string, cause?: unknown) =>
  new ThemePublicationError({
    message,
    reason: "invalid",
    ...(cause === undefined ? {} : { cause }),
  });

export const layer = Layer.effect(
  ThemePublicationService,
  Effect.gen(function* () {
    const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
    const settings = yield* Settings.ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const semaphore = yield* Semaphore.make(1);
    const set = Effect.fn("ThemePublication.set")(function* (
      input: SetInput,
      authorize: Effect.Effect<void, ServerSettingsError>,
    ) {
      return yield* semaphore.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const id = input.themeId ?? "";
            if (input.themeId === undefined && input.appearance === undefined)
              return yield* invalid("Choose a theme or appearance.");
            if (
              input.appearance !== undefined &&
              input.appearance !== "light" &&
              input.appearance !== "dark" &&
              input.appearance !== "system"
            )
              return yield* invalid("Invalid appearance.");
            if (id !== "" && !isThemeId(id)) return yield* invalid("Invalid theme id.");
            if (input.theme && (id === "" || UNPUBLISHABLE_THEME_IDS.has(id)))
              return yield* invalid("This theme id cannot be published.");
            if (input.theme && !environmentThemeFileHasColors(input.theme))
              return yield* invalid("A published theme needs colors.");
            const cssResult = yield* Effect.try({
              try: () =>
                input.theme?.css === undefined ? undefined : sanitizeThemeCss(input.theme.css),
              catch: (cause) => invalid("Invalid theme CSS.", cause),
            });
            const serialized = yield* Effect.try({
              try: () =>
                input.theme === undefined
                  ? undefined
                  : encodeTheme({
                      ...input.theme,
                      ...(cssResult === undefined ? {} : { css: cssResult }),
                    }),
              catch: (cause) => invalid("Invalid theme file.", cause),
            });
            if (serialized !== undefined && Buffer.byteLength(serialized) > MAX_THEME_FILE_BYTES)
              return yield* invalid("Theme file is too large.");
            if (
              serialized === undefined &&
              id !== "" &&
              !BUILT_IN_THEME_IDS.some((builtIn) => builtIn === id)
            ) {
              const themes = yield* readPublishedThemes(environmentThemesDir).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.mapError((cause) => invalid("Cannot read themes.", cause)),
              );
              if (!themes.some((theme) => theme.id === id))
                return yield* invalid("Theme is not published.");
            }
            const whileLocked =
              serialized === undefined
                ? (effect: Effect.Effect<void, ThemePublicationError>) => effect
                : yield* acquireThemePublishLock(environmentThemesDir, id).pipe(
                    Effect.provideService(FileSystem.FileSystem, fs),
                    Effect.mapError((cause) =>
                      invalid("Theme directory is busy or unavailable.", cause),
                    ),
                  );
            const publishedBefore =
              serialized === undefined
                ? []
                : yield* readPublishedThemes(environmentThemesDir).pipe(
                    Effect.provideService(FileSystem.FileSystem, fs),
                    Effect.mapError((cause) => invalid("Cannot read themes.", cause)),
                  );
            let rollback: (() => void) | undefined;
            const stage =
              serialized === undefined
                ? Effect.void
                : Effect.try({
                    try: () => {
                      NodeFS.mkdirSync(environmentThemesDir, { recursive: true });
                      const directory = NodeFS.opendirSync(environmentThemesDir);
                      let entries = 0;
                      let themeFiles = 0;
                      try {
                        while (true) {
                          const entry = directory.readSync();
                          if (entry === null) break;
                          if (++entries > MAX_THEME_DIRECTORY_ENTRIES)
                            throw new Error("Theme directory exceeds its scan limit.");
                          if (entry.name.endsWith(".json")) themeFiles++;
                        }
                      } finally {
                        directory.closeSync();
                      }
                      const destination = NodePath.join(environmentThemesDir, `${id}.json`);
                      let previous: string | null = null;
                      try {
                        const stat = NodeFS.lstatSync(destination);
                        if (!stat.isFile() || stat.isSymbolicLink())
                          throw new Error("Theme destination is not a regular file.");
                        previous = readThemeFileGuarded(destination, MAX_THEME_FILE_BYTES);
                        if (previous === null) throw new Error("Cannot read previous theme.");
                      } catch (cause) {
                        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
                        if (themeFiles >= MAX_THEME_FILES)
                          throw new Error("Theme directory is full.", { cause });
                      }
                      const staging = NodePath.join(
                        environmentThemesDir,
                        `.theme-${NodeCrypto.randomUUID()}.tmp`,
                      );
                      const inode = createStaging(staging, serialized);
                      let published = false;
                      rollback = () => {
                        if (!published) return;
                        let current;
                        try {
                          current = NodeFS.lstatSync(destination);
                        } catch (cause) {
                          if ((cause as NodeJS.ErrnoException).code === "ENOENT")
                            throw new Error("Theme was removed before rollback.", { cause });
                          throw cause;
                        }
                        if (!current.isFile() || current.ino !== inode)
                          throw new Error("Theme changed before rollback.");
                        if (previous === null) NodeFS.unlinkSync(destination);
                        else {
                          const temp = NodePath.join(
                            environmentThemesDir,
                            `.theme-${NodeCrypto.randomUUID()}.tmp`,
                          );
                          createStaging(temp, previous);
                          try {
                            NodeFS.renameSync(temp, destination);
                          } catch (cause) {
                            cleanupStagingAfterFailure(temp, cause);
                          }
                        }
                      };
                      try {
                        NodeFS.renameSync(staging, destination);
                        published = true;
                      } catch (cause) {
                        cleanupStagingAfterFailure(staging, cause);
                      }
                    },
                    catch: (cause) =>
                      new ServerSettingsError({
                        settingsPath: "theme:publish",
                        operation: "write-file",
                        cause,
                      }),
                  });
            const prepare =
              serialized === undefined
                ? stage
                : stage.pipe(
                    Effect.andThen(
                      readPublishedThemes(environmentThemesDir).pipe(
                        Effect.provideService(FileSystem.FileSystem, fs),
                        Effect.mapError(
                          (cause) =>
                            new ServerSettingsError({
                              settingsPath: "theme:publish",
                              operation: "write-file",
                              cause,
                            }),
                        ),
                        Effect.flatMap((themes) =>
                          themes.some((theme) => theme.id === id) &&
                          publishedBefore.every((previous) =>
                            themes.some((theme) => theme.id === previous.id),
                          ) &&
                          readThemeFileGuarded(
                            NodePath.join(environmentThemesDir, `${id}.json`),
                            MAX_THEME_FILE_BYTES,
                          ) === serialized
                            ? Effect.void
                            : Effect.fail(
                                new ServerSettingsError({
                                  settingsPath: "theme:publish",
                                  operation: "write-file",
                                }),
                              ),
                        ),
                      ),
                    ),
                  );
            const now = DateTime.formatIso(yield* DateTime.now);
            if (!settings.setDefaultTheme) return yield* invalid("Theme selection is unavailable.");
            const result = yield* settings
              .setDefaultTheme(
                {
                  ...(input.themeId === undefined ? {} : { themeId: id }),
                  ...(input.appearance === undefined ? {} : { appearance: input.appearance }),
                  ...(input.themeId === "" ? { stockReset: true } : {}),
                  setAt: now,
                  agent: input.agent,
                },
                authorize,
                prepare,
              )
              .pipe(Effect.result);
            if (result._tag === "Failure") {
              if (rollback !== undefined) {
                yield* whileLocked(
                  Effect.try({
                    try: rollback,
                    catch: (cause) => invalid("Theme rollback failed.", cause),
                  }),
                );
              }
              if (result.failure.settingsPath === "theme:agent-disabled")
                return yield* new ThemePublicationError({
                  message: "A person has disabled agent theme changes.",
                  reason: "denied",
                });
              if (result.failure.settingsPath === "mcp:settings-update-client-revoked")
                return yield* new ThemePublicationError({
                  message: "The settings grant is no longer available.",
                  reason: "denied",
                });
              return yield* new ThemePublicationError({
                message: "Theme could not be published or selected.",
                cause: result.failure,
              });
            }
          }).pipe(Effect.scoped),
        ),
      );
    });
    return ThemePublicationService.of({ set });
  }),
);
