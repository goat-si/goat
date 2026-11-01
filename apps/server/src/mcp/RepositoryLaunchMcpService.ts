import {
  OrchestratorMcpFailure,
  type HostStatusEntry,
  type RepositoryLaunchSelection,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as HostStatusMcpService from "./HostStatusMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export class RepositoryLaunchMcpService extends Context.Service<
  RepositoryLaunchMcpService,
  {
    readonly check: (
      scope: McpInvocationScope,
      input: {
        readonly host: string;
        readonly path: string;
        readonly repository: RepositoryLaunchSelection;
      },
    ) => Effect.Effect<ReadonlyArray<string>, OrchestratorMcpFailure>;
  }
>()("goat/mcp/RepositoryLaunchMcpService") {}

const make = Effect.gen(function* () {
  const status = yield* HostStatusMcpService.HostStatusMcpService;
  const read = Effect.fn("RepositoryLaunch.read")(function* (
    scope: McpInvocationScope,
    host: string | null,
  ) {
    const result = yield* status
      .read(
        scope,
        {
          ...(host === null ? { local: true } : { host }),
          repositories: true,
        },
        { requireReady: true },
      )
      .pipe(
        Effect.catch((error) =>
          error.code === "invalid_request" && host !== null
            ? // Older closed tool schemas reject the new argument. Keep the refusal diagnostic,
              // while authorization and caller-lifetime failures still stop all candidate reads.
              Effect.succeed({ hosts: [{ host, reachability: "unsupported" as const }] })
            : Effect.fail(error),
        ),
      );
    return result.hosts[0];
  });
  const matches = (host: HostStatusEntry | undefined, key: string) =>
    host?.reachability === "ok" && !host.lastKnown
      ? (host.repositories?.entries.filter(
          (repo) => repo.originKey === key && repo.state === "available",
        ) ?? [])
      : [];

  const check: RepositoryLaunchMcpService["Service"]["check"] = Effect.fn("RepositoryLaunch.check")(
    function* (scope, input) {
      const target = yield* read(scope, input.host);
      const matching = matches(target, input.repository.key);
      // Browsing aliases can wake a host. Diagnosis only compares inventory paths and never
      // acquires a runtime or resolves an arbitrary source through a remote shell.
      const selected = matching.find((repo) => repo.path === input.path.replace(/[\\/]+$/, ""));
      const notes: Array<string> = [];
      if (selected !== undefined) {
        notes.push(
          `Repository ${input.repository.key} is registered at ${selected.path} on ${input.host}; HEAD ${selected.head ?? "unknown"}.`,
        );
        if (selected.dirty)
          notes.push(
            "The selected checkout has uncommitted changes; a new worktree does not copy them.",
          );
        if (selected.dirty === null)
          notes.push(
            "Working tree changes could not be safely inspected; do not assume the checkout is clean.",
          );
        if (selected.ahead !== null && selected.ahead > 0)
          notes.push(
            `${selected.ahead} commits are ahead of the local upstream tracking ref. Starting from origin may omit them; select a local base explicitly to retain that work.`,
          );
        if (selected.ahead === null)
          notes.push(
            "Upstream divergence is unknown; this is not evidence that all work is pushed.",
          );
        notes.push(
          "Dependency install freshness is unknown. Inventory does not fetch remotes or install dependencies.",
        );
        return notes;
      }

      const reason =
        target?.reachability === "unsupported"
          ? "host does not expose repository inventory"
          : target?.reachability !== "ok"
            ? "host unavailable"
            : target.repositories === undefined
              ? "host does not expose repository inventory"
              : target.repositories.truncated
                ? "bounded inventory is incomplete; requested checkout was not verified"
                : "requested path is missing, unregistered, or has a different origin; use the canonical path returned by inventory";
      const candidates = [yield* read(scope, null)];
      for (const host of new Set(input.repository.candidateHosts ?? [])) {
        if (host !== input.host) candidates.push(yield* read(scope, host));
      }
      for (const candidate of [target, ...candidates]) {
        const repos = matches(candidate, input.repository.key);
        for (const repo of repos.slice(0, 3)) {
          notes.push(
            `${candidate?.host ?? "local"}: ${repo.path}, HEAD ${repo.head ?? "unknown"}, dirty=${String(repo.dirty)}, ahead=${repo.ahead ?? "unknown"}; dependency freshness unknown`,
          );
        }
        if (candidate !== target && repos.length === 0) {
          notes.push(
            `${candidate?.host ?? "local"}: ${candidate?.reachability !== "ok" ? "unavailable" : candidate.repositories === undefined ? "inventory unsupported" : "no verified matching checkout in bounded inventory"}`,
          );
        }
      }
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Repository launch refused on ${input.host}: ${reason}. Candidates (local refs only, no fetch): ${notes.join("; ")}`,
      });
    },
  );
  return RepositoryLaunchMcpService.of({ check });
});

export const layer = Layer.effect(RepositoryLaunchMcpService, make);
