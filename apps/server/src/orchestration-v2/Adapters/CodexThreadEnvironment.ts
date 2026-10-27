import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// One app-server hosts many threads, so its process must never carry a thread credential.
export const codexThreadMcpEnvironment = (
  session: McpProviderSession.McpProviderSessionConfig | undefined,
) =>
  Object.fromEntries(
    Object.entries(McpProviderSession.withThreadAgentEnvironment({}, session)).map(
      ([name, value]) => [`shell_environment_policy.set.${name}`, value ?? ""],
    ),
  );

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const configSetsBrowser = (config: unknown) => {
  const policy = isRecord(config) ? config.shell_environment_policy : undefined;
  const set = isRecord(policy) ? policy.set : undefined;
  return isRecord(set) && Object.hasOwn(set, "BROWSER");
};

/**
 * Drops GOAT's opener for a directory whose merged Codex config sets BROWSER in its shell
 * environment policy, since GOAT's thread entry would replace it. Read once per directory; an
 * unreadable config yields to the user for that call and is read again next time.
 */
export const makeCodexConfiguredBrowser = <E, R>(
  readConfig: (cwd: string | null) => Effect.Effect<{ readonly config: unknown }, E, R>,
) => {
  const setsBrowserByCwd = new Map<string, boolean>();
  return Effect.fn("CodexThreadEnvironment.withoutConfiguredBrowser")(function* (
    session: McpProviderSession.McpProviderSessionConfig | undefined,
    cwd: string | null | undefined,
  ) {
    if (session?.urlOpener === undefined) return session;
    const key = cwd ?? "";
    let setsBrowser = setsBrowserByCwd.get(key);
    if (setsBrowser === undefined) {
      const read = yield* readConfig(cwd ?? null).pipe(Effect.option);
      setsBrowser = Option.match(read, {
        onNone: () => true,
        onSome: (response) => configSetsBrowser(response.config),
      });
      if (Option.isSome(read)) setsBrowserByCwd.set(key, setsBrowser);
    }
    if (!setsBrowser) return session;
    const { urlOpener: _, ...rest } = session;
    const withoutOpener: McpProviderSession.McpProviderSessionConfig = rest;
    return withoutOpener;
  });
};
