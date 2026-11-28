import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const McpServerName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/));
export type McpServerName = typeof McpServerName.Type;
export const EnvKey = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/));
export type EnvKey = typeof EnvKey.Type;
export const HeaderName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,64}$/));

export type HeaderName = typeof HeaderName.Type;

export const McpServerUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      const loopback =
        url.hostname === "localhost" ||
        url.hostname === "[::1]" ||
        /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
      return (
        (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
        !/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(
          value
            .trim()
            .replace(/[\t\n\r]/g, "")
            .replaceAll("\\", "/"),
        ) &&
        !url.username &&
        !url.password &&
        !value.includes("?") &&
        !value.includes("#")
      );
    } catch {
      return false;
    }
  }),
);

const validName = Schema.is(McpServerName);
const validEnvKey = Schema.is(EnvKey);
const validHeaderName = Schema.is(HeaderName);
const secretEnv = Schema.Record(Schema.String, Schema.String)
  .check(Schema.makeFilter((values) => Object.keys(values).every(validEnvKey)))
  .annotateKey({ settingsSecret: true });
const secretHeaders = Schema.Record(Schema.String, Schema.String)
  .check(Schema.makeFilter((values) => Object.keys(values).every(validHeaderName)))
  .annotateKey({ settingsSecret: true });

const enabled = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)));
export const GoatMcpServer = Schema.Union([
  Schema.Struct({
    enabled,
    transport: Schema.Literal("stdio"),
    command: Schema.String.check(Schema.isMinLength(1)),
    args: Schema.Array(Schema.String),
    env: secretEnv,
  }),
  Schema.Struct({
    enabled,
    transport: Schema.Literal("http"),
    url: McpServerUrl,
    headers: secretHeaders,
  }),
]);
export type GoatMcpServer = typeof GoatMcpServer.Type;
export type GoatMcpServerLaunch =
  | ({ readonly providerName: string } & Omit<
      Extract<GoatMcpServer, { transport: "stdio" }>,
      "enabled"
    >)
  | ({ readonly providerName: string } & Omit<
      Extract<GoatMcpServer, { transport: "http" }>,
      "enabled"
    >);

export const goatMcpProviderName = (name: string) => `${name}_goat`;

export const GOAT_MCP_SERVER_SUPPORT: Readonly<
  Record<string, ReadonlyArray<GoatMcpServer["transport"]>>
> = {
  codex: ["stdio", "http"],
  claudeAgent: ["stdio", "http"],
  cursor: ["stdio", "http"],
  grok: ["stdio"],
  antigravity: ["stdio"],
  acpRegistry: ["stdio"],
  fx: ["stdio"],
};

export function resolveGoatMcpServersForDriver(
  servers: Readonly<Record<string, GoatMcpServer>>,
  driver: string,
): ReadonlyArray<GoatMcpServerLaunch> {
  const supported = Object.hasOwn(GOAT_MCP_SERVER_SUPPORT, driver)
    ? (GOAT_MCP_SERVER_SUPPORT[driver] ?? [])
    : [];
  return Object.entries(servers).flatMap(([name, server]) => {
    if (!server.enabled || !supported.includes(server.transport)) return [];
    const { enabled: _enabled, ...config } = server;
    return [{ providerName: goatMcpProviderName(name), ...config }];
  });
}

export const GoatMcpServerSettingsFields = {
  mcpServers: Schema.Record(Schema.String, GoatMcpServer)
    .check(Schema.makeFilter((servers) => Object.keys(servers).every(validName)))
    .pipe(Schema.withDecodingDefault(Effect.succeed({}))),
};
export const GoatMcpServerSettingsPatchFields = {
  mcpServers: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.NullOr(GoatMcpServer)).check(
      Schema.makeFilter((servers) => Object.keys(servers).every(validName)),
    ),
  ),
};
