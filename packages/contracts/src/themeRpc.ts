import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { THEME_CSS_MAX_LENGTH, ThemeCssValidationError } from "./server.ts";
import { EnvironmentThemeId } from "./server.ts";
import { AssetCreateUrlResult } from "./assets.ts";

export const PUBLISHED_BACKGROUND_MAX_BYTES = 16 * 1024 * 1024;

export const THEME_WS_METHODS = {
  themeValidateCss: "theme.validateCss",
  themeBackgroundUrl: "theme.backgroundUrl",
} as const;

export const WsThemeValidateCssRpc = Rpc.make(THEME_WS_METHODS.themeValidateCss, {
  payload: Schema.Struct({ css: Schema.String.check(Schema.isMaxLength(THEME_CSS_MAX_LENGTH)) }),
  success: Schema.Struct({ css: Schema.String }),
  error: Schema.Union([ThemeCssValidationError, EnvironmentAuthorizationError]),
});

export class ThemeBackgroundUrlError extends Schema.TaggedError<ThemeBackgroundUrlError>()(
  "ThemeBackgroundUrlError",
  { message: Schema.String },
) {}

export const WsThemeBackgroundUrlRpc = Rpc.make(THEME_WS_METHODS.themeBackgroundUrl, {
  payload: Schema.Struct({
    themeId: EnvironmentThemeId,
    revision: Schema.String.check(Schema.isMaxLength(72)),
  }),
  success: Schema.NullOr(AssetCreateUrlResult),
  error: Schema.Union([ThemeBackgroundUrlError, EnvironmentAuthorizationError]),
});
