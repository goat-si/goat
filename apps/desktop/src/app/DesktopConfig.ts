import { OtlpHeadersFromString, OtlpProtocol } from "@goat/shared/observability";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

const trimmedString = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

const optionalBoolean = (name: string) =>
  Config.Boolean(name).pipe(Config.option, Config.map(Option.getOrElse(() => false)));

const optionalTruthyFlag = (name: string) =>
  trimmedString(name).pipe(
    Config.map(
      Option.exists((value) => {
        const normalized = value.toLowerCase();
        return normalized === "1" || normalized === "true";
      }),
    ),
  );

const commaSeparatedStrings = (name: string) =>
  trimmedString(name).pipe(
    Config.map(
      Option.match({
        onNone: () => [],
        onSome: (value) =>
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
      }),
    ),
  );

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const DesktopConfig = Config.all({
  appDataDirectory: trimmedString("APPDATA"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  xdgDataHome: trimmedString("XDG_DATA_HOME"),
  goatHome: trimmedString("GOAT_HOME"),
  devServerUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option),
  appUserModelIdOverride: trimmedString("GOAT_DESKTOP_APP_USER_MODEL_ID"),
  devRemoteGoatServerEntryPath: trimmedString("GOAT_DEV_REMOTE_SERVER_ENTRY_PATH"),
  sshRuntimeArchiveDir: trimmedString("GOAT_SSH_RUNTIME_ARCHIVE_DIR"),
  cliReleaseBaseUrl: trimmedString("GOAT_RELEASE_BASE_URL"),
  configuredBackendPort: Config.Port("GOAT_PORT").pipe(Config.option),
  commitHashOverride: trimmedString("GOAT_COMMIT_HASH"),
  desktopLanHostOverride: trimmedString("GOAT_DESKTOP_LAN_HOST"),
  desktopHttpsEndpointUrls: commaSeparatedStrings("GOAT_DESKTOP_HTTPS_ENDPOINTS"),
  otlpTracesUrl: trimmedString("GOAT_OTLP_TRACES_URL"),
  otlpMetricsUrl: trimmedString("GOAT_OTLP_METRICS_URL"),
  otlpLogsUrl: trimmedString("GOAT_OTLP_LOGS_URL"),
  otlpExportIntervalMs: Config.Int("GOAT_OTLP_EXPORT_INTERVAL_MS").pipe(Config.withDefault(10_000)),
  otlpHeaders: Config.schema(OtlpHeadersFromString, "GOAT_OTLP_HEADERS").pipe(Config.option),
  otlpProtocol: Config.schema(OtlpProtocol, "GOAT_OTLP_PROTOCOL").pipe(
    Config.withDefault("http/json"),
  ),
  desktopLauncherPath: trimmedString("GOAT_DESKTOP_LAUNCHER_PATH"),
  appImagePath: trimmedString("APPIMAGE"),
  disableAutoUpdate: optionalBoolean("GOAT_DISABLE_AUTO_UPDATE"),
  insecureDevSecretStorage: optionalTruthyFlag("GOAT_DEV_INSECURE_SECRET_STORAGE"),
  mockUpdates: optionalBoolean("GOAT_DESKTOP_MOCK_UPDATES"),
  mockUpdateServerPort: Config.Port("GOAT_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(
    Config.withDefault(3000),
  ),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
