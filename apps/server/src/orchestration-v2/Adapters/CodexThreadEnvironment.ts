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
 * Drops GOAT's opener where the merged Codex config sets BROWSER in its shell environment policy,
 * since GOAT's thread entry would replace it. Read on every thread setup, so edits apply to the
 * next load; an unreadable config yields to the user.
 */
export const makeCodexConfiguredBrowser = <E, R>(
  readConfig: (cwd: string | null) => Effect.Effect<{ readonly config: unknown }, E, R>,
) =>
  Effect.fn("CodexThreadEnvironment.withoutConfiguredBrowser")(function* (
    session: McpProviderSession.McpProviderSessionConfig | undefined,
    cwd: string | null | undefined,
  ) {
    if (session?.urlOpener === undefined) return session;
    const setsBrowser = Option.match(yield* readConfig(cwd ?? null).pipe(Effect.option), {
      onNone: () => true,
      onSome: (response) => configSetsBrowser(response.config),
    });
    if (!setsBrowser) return session;
    const { urlOpener: _, ...rest } = session;
    const withoutOpener: McpProviderSession.McpProviderSessionConfig = rest;
    return withoutOpener;
  });
