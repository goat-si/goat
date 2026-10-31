import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BrowserOrigin } from "./browserClaims.ts";

export const DesktopCuaManifestRequest = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("cuaManifestRequest"),
  requestId: TrimmedNonEmptyString,
  union: Schema.Struct({
    existingProfiles: Schema.Array(Schema.Struct({ pid: Schema.Int, windowId: Schema.Int })),
    origins: Schema.Array(BrowserOrigin),
  }),
});
export type DesktopCuaManifestRequest = typeof DesktopCuaManifestRequest.Type;

export const DesktopCuaManifestReport = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("cuaManifestReport"),
    requestId: TrimmedNonEmptyString,
    status: Schema.Literal("written"),
    sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("cuaManifestReport"),
    requestId: TrimmedNonEmptyString,
    status: Schema.Literal("unavailable"),
  }),
]);
export type DesktopCuaManifestReport = typeof DesktopCuaManifestReport.Type;
