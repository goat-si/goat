import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { codexThreadMcpEnvironment, makeCodexConfiguredBrowser } from "./CodexThreadEnvironment.ts";

const session = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer fixture",
  browserToolsAvailable: true,
  urlOpener: "/tmp/goat-threads-fixture/goat-browser",
};
const browserOf = (config: ReturnType<typeof codexThreadMcpEnvironment>) =>
  config["shell_environment_policy.set.BROWSER"];

describe("Codex thread BROWSER", () => {
  it.effect("keeps a BROWSER the user's Codex config sets for a directory", () =>
    Effect.gen(function* () {
      const configs: Record<string, unknown> = {
        "/chosen": { shell_environment_policy: { set: { BROWSER: "firefox" } } },
        "/plain": { shell_environment_policy: { inherit: "all" } },
      };
      const withoutConfiguredBrowser = makeCodexConfiguredBrowser((cwd) =>
        Effect.succeed({ config: configs[cwd ?? ""] }),
      );

      const chosen = yield* withoutConfiguredBrowser(session, "/chosen");
      const plain = yield* withoutConfiguredBrowser(session, "/plain");

      expect(browserOf(codexThreadMcpEnvironment(chosen))).toBeUndefined();
      expect(browserOf(codexThreadMcpEnvironment(plain))).toBe(session.urlOpener);
    }),
  );

  it.effect("yields to the user while Codex's config cannot be read, and reads it again", () =>
    Effect.gen(function* () {
      let reads = 0;
      const withoutConfiguredBrowser = makeCodexConfiguredBrowser(() => {
        reads += 1;
        return reads === 1 ? Effect.fail("app-server unavailable") : Effect.succeed({ config: {} });
      });

      const unreadable = yield* withoutConfiguredBrowser(session, "/project");
      const readable = yield* withoutConfiguredBrowser(session, "/project");

      expect(unreadable?.urlOpener).toBeUndefined();
      expect(readable?.urlOpener).toBe(session.urlOpener);
    }),
  );
});
