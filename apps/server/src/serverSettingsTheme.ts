import { ServerSettingsError, type ServerSettings } from "@goat/contracts";
import { normalizeThemePreference } from "@goat/shared/themePalettes";
import * as Effect from "effect/Effect";

export type DefaultThemeSetter = (
  input: {
    readonly themeId?: string;
    readonly appearance?: string;
    readonly setAt: string;
    readonly agent?: boolean;
  },
  authorizeAtCommit?: Effect.Effect<void, ServerSettingsError>,
  prepare?: Effect.Effect<void, ServerSettingsError>,
) => Effect.Effect<ServerSettings, ServerSettingsError>;

export function makeDefaultThemeSetter(
  update: (
    f: (current: ServerSettings) => Effect.Effect<ServerSettings, ServerSettingsError>,
    targets: readonly [],
    beforeCommit?: Effect.Effect<void, ServerSettingsError>,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>,
): DefaultThemeSetter {
  return Effect.fn("ServerSettings.setDefaultTheme")((input, authorizeAtCommit, prepare) =>
    update(
      (current) =>
        Effect.gen(function* () {
          if (input.agent && !current.enableAgentThemeWrites) {
            return yield* new ServerSettingsError({
              settingsPath: "theme:agent-disabled",
              operation: "write-file",
            });
          }
          if (
            input.appearance !== undefined &&
            input.appearance !== "light" &&
            input.appearance !== "dark" &&
            input.appearance !== "system"
          ) {
            return yield* new ServerSettingsError({
              settingsPath: "theme:invalid-appearance",
              operation: "write-file",
            });
          }
          if (prepare) yield* prepare;
          return {
            ...current,
            ...(input.themeId === undefined
              ? {}
              : {
                  defaultTheme: normalizeThemePreference(input.themeId),
                  defaultThemeSetAt: input.themeId === "" ? "" : input.setAt,
                }),
            ...(input.appearance === undefined
              ? {}
              : { defaultAppearance: input.appearance, defaultAppearanceSetAt: input.setAt }),
          };
        }),
      [],
      authorizeAtCommit,
    ),
  );
}
