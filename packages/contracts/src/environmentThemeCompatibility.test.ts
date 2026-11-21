import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EnvironmentThemeColor, EnvironmentThemeFile } from "./server.ts";

// Snapshot copied byte-for-byte from the base server.ts schema.
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
};

const OldEnvironmentThemeFile = Schema.Struct(environmentThemeFields);
const decodeOld = Schema.decodeUnknownSync(OldEnvironmentThemeFile);
const decodeNew = Schema.decodeUnknownSync(EnvironmentThemeFile);

describe("environment theme wire compatibility", () => {
  it("old and new clients decode themes with and without CSS", () => {
    const old = { name: "Example", appearance: "dark", canvas: "#112233", accent: "#aabbcc" };
    const withCss = { ...old, css: '[data-slot="sidebar"]{color:red}' };
    expect(decodeNew(old)).toEqual(old);
    expect(decodeNew(withCss)).toEqual(withCss);
    expect(decodeOld(withCss)).toEqual(old);
  });
});
