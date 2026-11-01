import {
  LEGACY_DESKTOP_BOOTSTRAP_HOME_KEY,
  GOAT_DESKTOP_BOOTSTRAP_HOME_KEY,
} from "@goat/contracts/legacyT3Names";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

import { PortSchema, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

// A supervisor must not restart a server refused by the state-directory owner.
export const SERVER_EXIT_CODE_STATE_DIR_OWNED = 78;

// A supervisor must not restart a server whose database a newer build migrated; only a newer build can open it.
export const SERVER_EXIT_CODE_DATABASE_AHEAD = 79;

const GoatDesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  // Omit in WSL to use the Linux home instead of the mapped Windows directory.
  [GOAT_DESKTOP_BOOTSTRAP_HOME_KEY]: Schema.optional(Schema.String),
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  // Derives rotating tokens instead of trusting desktopBootstrapToken indefinitely; see @goat/shared/desktopBootstrapToken.
  desktopBootstrapSecret: Schema.optionalKey(Schema.String),
  // Absent means the backend must hydrate PATH, as WSL and older desktops require.
  shellEnvironmentPrepared: Schema.optionalKey(Schema.Boolean),
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  otlpLogsUrl: Schema.optional(Schema.String),
  desktopTelemetryFd: Schema.optionalKey(PositiveInt),
  desktopTelemetryControlFd: Schema.optionalKey(PositiveInt),
  desktopBrowserFd: Schema.optionalKey(PositiveInt),
  desktopBrowserControlFd: Schema.optionalKey(PositiveInt),
  resourceMonitorPath: Schema.optionalKey(TrimmedNonEmptyString),
});

/** Normalize both input spellings while encoding only the GOAT peer key. */
export const DesktopBackendBootstrap = Schema.Struct({
  ...GoatDesktopBackendBootstrap.fields,
  [LEGACY_DESKTOP_BOOTSTRAP_HOME_KEY]: Schema.optionalKey(Schema.String),
}).pipe(
  Schema.decodeTo(Schema.toType(GoatDesktopBackendBootstrap), {
    decode: SchemaGetter.transform(
      ({ [LEGACY_DESKTOP_BOOTSTRAP_HOME_KEY]: legacyHome, ...bootstrap }) => ({
        ...bootstrap,
        [GOAT_DESKTOP_BOOTSTRAP_HOME_KEY]: bootstrap[GOAT_DESKTOP_BOOTSTRAP_HOME_KEY] ?? legacyHome,
      }),
    ),
    encode: SchemaGetter.transform((bootstrap) => bootstrap),
  }),
);

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;

/** Written to `<goatHome>/runtime` before update shutdown so the backend retains its managed tunnel. */
export const DESKTOP_UPDATE_RESTART_MARKER_FILE = "desktop-update-restart";
