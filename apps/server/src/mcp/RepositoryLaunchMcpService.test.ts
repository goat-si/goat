import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type HostStatusEntry,
  type RepositoryInventoryEntry,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as HostStatusMcpService from "./HostStatusMcpService.ts";
import * as RepositoryLaunchMcpService from "./RepositoryLaunchMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  thread: undefined,
  client: { sessionId: "fixture", label: "fixture", access: "full-access" },
};
const repository = (
  overrides: Partial<RepositoryInventoryEntry> = {},
): RepositoryInventoryEntry => ({
  path: "/repos/project",
  originKey: "github.com/owner/repo",
  state: "available",
  branch: "main",
  head: "a".repeat(40),
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  dirty: false,
  dependencies: { state: "unknown", installedAt: null },
  ...overrides,
});
const host = (
  name: string | null,
  entries: ReadonlyArray<RepositoryInventoryEntry>,
): HostStatusEntry => ({
  host: name,
  reachability: "ok",
  repositories: { sampledAt: 0, entries, truncated: false },
});
const run = (
  hosts: ReadonlyArray<HostStatusEntry>,
  overrides?: { path?: string; deny?: boolean; rejectInventory?: boolean },
) => {
  const calls: Array<string | null> = [];
  return Effect.gen(function* () {
    const service = yield* RepositoryLaunchMcpService.RepositoryLaunchMcpService;
    const result = yield* service
      .check(scope, {
        host: "selected",
        path: overrides?.path ?? "/repos/project",
        repository: { key: "github.com/owner/repo", candidateHosts: ["candidate"] },
      })
      .pipe(Effect.result);
    return { result, calls };
  }).pipe(
    Effect.provide(
      RepositoryLaunchMcpService.layer.pipe(
        Layer.provide(
          Layer.mock(HostStatusMcpService.HostStatusMcpService)({
            read: (receivedScope, input) =>
              Effect.gen(function* () {
                expect(receivedScope).toBe(scope);
                expect(input.repositories).toBe(true);
                calls.push(input.host ?? null);
                if (overrides?.rejectInventory && input.host === "selected")
                  return yield* new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: "goat_host_status does not take repositories",
                  });
                if (overrides?.deny)
                  return yield* new OrchestratorMcpFailure({
                    code: "capability_denied",
                    message: "denied",
                  });
                return {
                  hosts: [
                    hosts.find((entry) => entry.host === (input.host ?? null)) ?? {
                      host: input.host ?? null,
                      reachability: "unreachable" as const,
                    },
                  ],
                };
              }),
          }),
        ),
      ),
    ),
  );
};

it.effect("warns about dirty and unpushed work without probing candidate hosts on success", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* run([
      host("selected", [repository({ dirty: true, ahead: 2 })]),
    ]);
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.success.join(" ")).toContain("uncommitted changes");
      expect(result.success.join(" ")).toContain("2 commits");
      expect(result.success.join(" ")).toContain("freshness is unknown");
    }
    expect(calls).toEqual(["selected"]);
  }),
);

it.effect("refuses a mismatched origin and gives only matching registered candidate paths", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* run([
      host("selected", [repository({ originKey: "github.com/other/repo" })]),
      host(null, []),
      host("candidate", [repository({ path: "/candidate/repo", ahead: 3 })]),
    ]);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("different origin");
      expect(result.failure.message).toContain("candidate: /candidate/repo");
      expect(result.failure.message).toContain("ahead=3");
    }
    expect(calls).toEqual(["selected", null, "candidate"]);
  }),
);

it.effect("refuses unavailable and older hosts without treating stale inventory as proof", () =>
  Effect.gen(function* () {
    for (const selected of [
      { host: "selected", reachability: "ok" as const },
      {
        ...host("selected", [repository()]),
        reachability: "unreachable" as const,
        lastKnown: true as const,
      },
    ]) {
      const { result } = yield* run([selected]);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.message).toContain("Repository launch refused");
    }
  }),
);

it.effect("does not normalize traversal or shell fragments into an authorized candidate path", () =>
  Effect.gen(function* () {
    for (const path of [
      "/repos/project/../other",
      "/repos/project; touch /tmp/never",
      "~/project",
    ]) {
      const { result } = yield* run([host("selected", [repository()])], { path });
      expect(result._tag).toBe("Failure");
    }
  }),
);

it.effect(
  "accepts a trailing separator but refuses aliases without browsing or waking the host",
  () =>
    Effect.gen(function* () {
      for (const path of ["/repos/project/", "~/project", "/repos/alias"]) {
        const { result } = yield* run([host("selected", [repository()])], {
          path,
        });
        expect(result._tag).toBe(path === "/repos/project/" ? "Success" : "Failure");
      }
    }),
);

it.effect("preserves requester denial and does not fan out after it", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* run([], { deny: true });
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("capability_denied");
    expect(calls).toEqual(["selected"]);
  }),
);

it.effect("does not call an unknown HEAD unborn in either selected or candidate diagnostics", () =>
  Effect.gen(function* () {
    const selected = yield* run([host("selected", [repository({ head: null, dirty: null })])]);
    expect(selected.result._tag).toBe("Success");
    if (selected.result._tag === "Success") {
      expect(selected.result.success.join(" ")).toContain("HEAD unknown");
      expect(selected.result.success.join(" ")).not.toContain("unborn");
    }
    const candidate = yield* run([host("candidate", [repository({ head: null })])]);
    expect(candidate.result._tag).toBe("Failure");
    if (candidate.result._tag === "Failure") {
      expect(candidate.result.failure.message).toContain("HEAD unknown");
      expect(candidate.result.failure.message).not.toContain("unborn");
    }
  }),
);

it.effect("offers candidates when an older host rejects the inventory argument", () =>
  Effect.gen(function* () {
    const { result } = yield* run([host("candidate", [repository()])], { rejectInventory: true });
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("host does not expose repository inventory");
      expect(result.failure.message).toContain("candidate: /repos/project");
    }
  }),
);
