import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  EnvironmentTheme,
  EnvironmentThemeColor,
  EnvironmentThemeId,
  THEME_CSS_MAX_LENGTH,
} from "./server.ts";

const EnvironmentThemeColors = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/)),
  TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
);

const environmentThemeFields = {
  version: Schema.optional(Schema.Literal(1)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(48)),
  appearance: Schema.Literals(["light", "dark"]),
  /** Derive the palette from canvas/accent, then overlay colors; without them, colors is the palette. */
  canvas: Schema.optional(EnvironmentThemeColor),
  accent: Schema.optional(EnvironmentThemeColor),
  colors: Schema.optional(EnvironmentThemeColors),
  variants: Schema.optional(
    Schema.Struct({
      light: Schema.optional(EnvironmentThemeColors),
      dark: Schema.optional(EnvironmentThemeColors),
    }),
  ),
  css: Schema.optional(Schema.String.check(Schema.isMaxLength(THEME_CSS_MAX_LENGTH))),
};

const oldTheme = Schema.Struct({
  id: EnvironmentThemeId,
  ...environmentThemeFields,
});
const decodeOld = Schema.decodeUnknownSync(oldTheme);
const decodeNew = Schema.decodeUnknownSync(EnvironmentTheme);

it("old and new theme schemas decode the optional background identity", () => {
  const old = {
    id: "nightfall",
    name: "Nightfall",
    appearance: "dark",
    canvas: "#112233",
    accent: "#aabbcc",
  };
  const next = { ...old, background: "revision" };
  expect(decodeNew(old)).toEqual(old);
  expect(decodeNew(next)).toEqual(next);
  expect(decodeOld(next)).toEqual(old);
});
