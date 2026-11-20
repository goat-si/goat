import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { THEME_CSS_MAX_LENGTH, ThemeCssValidationError } from "./server.ts";

export const THEME_WS_METHODS = { themeValidateCss: "theme.validateCss" } as const;

export const WsThemeValidateCssRpc = Rpc.make(THEME_WS_METHODS.themeValidateCss, {
  payload: Schema.Struct({ css: Schema.String.check(Schema.isMaxLength(THEME_CSS_MAX_LENGTH)) }),
  success: Schema.Struct({ css: Schema.String }),
  error: Schema.Union([ThemeCssValidationError, EnvironmentAuthorizationError]),
});
