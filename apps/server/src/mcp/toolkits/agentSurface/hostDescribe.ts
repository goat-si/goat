import { OrchestratorMcpFailure } from "@goat/contracts";
import { resolveAgentSurfaceEntry, listedToolName } from "@goat/contracts/agentSurface/resolve";
import { compareRuntimeBuilds, type RuntimeBuild } from "@goat/shared/semver";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import packageJson from "../../../../package.json" with { type: "json" };
import { BUILD_COMMIT_TIME } from "../../../buildCommitTime.ts";
import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as LinkedHosts from "../../../linkedHosts/LinkedHosts.ts";
import * as HostThreadsMcpService from "../../HostThreadsMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { readCaller } from "../../threadAccess.ts";
import { availability, callerProfile, type CallerProfile } from "../../toolAvailability.ts";
import type { ToolDispatch } from "../../ToolDispatch.ts";
import { DescribeResult } from "./tools.ts";

/** The GOAT build answering goat_describe; a host search orders the host's against it. */
export const THIS_BUILD: { readonly version: string; readonly commitTime?: number } = {
  version: packageJson.version,
  ...(BUILD_COMMIT_TIME === undefined ? {} : { commitTime: BUILD_COMMIT_TIME }),
};

/**
 * Whether the host's build is older than this one, by runtime-build order: identical versions
 * are the same build. null when the host did not report a build (it predates reporting one) or
 * nothing proves an order, such as two dev builds without commit times.
 */
export const hostOlderThanHere = (build: RuntimeBuild | undefined): boolean | null => {
  if (build === undefined) return null;
  const order = compareRuntimeBuilds(build, THIS_BUILD);
  return order === undefined ? null : order < 0;
};

// A host's nextCursor, bound to that host and to the search that produced it, so it is never
// replayed against another machine or another query; the host checks its own part.
const HostCursor = Schema.fromJsonString(
  Schema.Struct({
    host: Schema.String,
    query: Schema.NullOr(Schema.String),
    path: Schema.NullOr(Schema.String),
    cursor: Schema.String,
  }),
);
const encodeHostCursorJson = Schema.encodeSync(HostCursor);
const decodeHostCursorJson = Schema.decodeUnknownOption(HostCursor);
const decodeHostCursor = (cursor: string) =>
  decodeHostCursorJson(Buffer.from(cursor, "base64url").toString("utf8"));

/** The host a cursor continues a search on, when it came from a host search. */
export const hostOfCursor = (cursor: string) =>
  Option.getOrUndefined(Option.map(decodeHostCursor(cursor), (decoded) => decoded.host));

const decodeDescribe = Schema.decodeUnknownEffect(DescribeResult);

const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

interface Available {
  readonly now: boolean;
  readonly reason?: string;
}
interface Listed {
  readonly path: string;
  readonly available?: Available;
}

export interface HostDescribeInput {
  readonly host: string;
  readonly path?: string | undefined;
  readonly query?: string | undefined;
  readonly detail?: "names" | "summary" | "full" | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

/**
 * goat_describe on another machine: that machine's registry, searched by its own goat_describe
 * through the dispatch session this caller gets there. Its availability is what the host refuses
 * that session; each entry is then also refused for what this machine refuses before sending
 * the call there: a path it cannot route to the host, the caller's own refusal here, and, for a
 * write, the interaction mode, link access and goatclaw host checks a routed write must pass.
 */
export const makeHostDescribe = (
  dispatch: ToolDispatch["Service"],
  permissions: Profiles.PermissionProfiles["Service"],
) =>
  Effect.fn("AgentSurface.describeOnHost")(function* (input: HostDescribeInput) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const { host } = input;
    const binding = { query: input.query ?? null, path: input.path ?? null };
    let remoteCursor: string | undefined;
    if (input.cursor !== undefined) {
      const decoded = Option.getOrUndefined(decodeHostCursor(input.cursor));
      if (decoded === undefined)
        return yield* refuse(
          `This cursor is not a nextCursor from a search on ${host}. Search ${host} again without cursor.`,
        );
      if (decoded.host !== host)
        return yield* refuse(
          `This cursor continues a search on ${decoded.host}, not ${host}. Pass host ${decoded.host} with it, or search ${host} again without cursor.`,
        );
      if (decoded.query !== binding.query || decoded.path !== binding.path)
        return yield* refuse(
          "This cursor belongs to another search. Pass the query and path it came with, or search again without cursor.",
        );
      remoteCursor = decoded.cursor;
    }
    const { limits } = yield* readCaller();
    const profile = yield* callerProfile(permissions, scope);
    const linked = yield* Effect.serviceOption(LinkedHosts.LinkedHosts).pipe(
      Effect.flatMap((links) =>
        Option.isNone(links)
          ? Effect.succeed(Option.none<LinkedHosts.LinkedHostCredential>())
          : links.value.find(host).pipe(Effect.orElseSucceed(() => Option.none())),
      ),
    );
    const hosts = yield* HostThreadsMcpService.HostThreadsMcpService;
    const result = yield* hosts.readOnHost(
      scope,
      {
        host,
        tool: "goat_describe",
        arguments: {
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.detail === undefined ? {} : { detail: input.detail }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(remoteCursor === undefined ? {} : { cursor: remoteCursor }),
        },
      },
      decodeDescribe,
    );

    /** Why this machine cannot carry this caller's call to the path on the host, if it cannot. */
    const refusedHere = (path: string): string | undefined => {
      const local = resolveAgentSurfaceEntry(path);
      if (local === undefined || local.path !== path)
        return `GOAT on this machine does not have ${path}, so it cannot call it on ${host}. Launch a thread on ${host} to use it, or update GOAT here.`;
      if (!local.hostRoutable)
        return `${path} does not take host on this machine, so it cannot be called on ${host} from here. Launch a thread on ${host} to use it.`;
      const here = availability(
        local,
        scope,
        dispatch.served(listedToolName(local)) !== undefined,
        profile,
      );
      if (!here.now) return here.reason;
      if (local.effect === "read") return undefined;
      if (limits.interactionMode !== "default")
        return `Changing anything on another machine needs a caller in default interaction mode; this caller is in ${limits.interactionMode} mode.`;
      if (Option.isSome(linked)) {
        const refusal = LinkedHosts.linkWriteRefusal(linked.value.host, limits.runtimeMode);
        if (refusal !== null) return refusal;
      }
      return profileHostRefusal(profile, host);
    };

    const fold = <E extends Listed>(entry: E): E => {
      if (entry.available !== undefined && !entry.available.now)
        return {
          ...entry,
          available: {
            now: false,
            reason: `On ${host}: ${entry.available.reason ?? "unavailable"}`,
          },
        };
      if (entry.available === undefined) return entry;
      const reason = refusedHere(entry.path);
      return reason === undefined ? entry : { ...entry, available: { now: false, reason } };
    };

    switch (result.depth) {
      case "surface":
        return result;
      case "resource":
        return { ...result, entries: result.entries.map(fold) };
      case "path":
        return { ...result, entry: fold(result.entry) };
      case "search": {
        const { nextCursor, ...rest } = result;
        return {
          ...rest,
          entries: result.entries.map(fold),
          ...(nextCursor === undefined
            ? {}
            : {
                nextCursor: Buffer.from(
                  encodeHostCursorJson({ host, ...binding, cursor: nextCursor }),
                ).toString("base64url"),
              }),
          coverage: {
            ...result.coverage,
            hostOlder: hostOlderThanHere(result.build),
            unavailableFromHere: result.entries.filter(
              (entry) => refusedHere(entry.path) !== undefined,
            ).length,
          },
        };
      }
    }
  });

/** What McpToolAccess.requireDeclaredCapability refuses for a write that names this host. */
const profileHostRefusal = (profile: CallerProfile | undefined, host: string) => {
  if (profile === undefined || !profile.resolved || !profile.effective.enabled) return undefined;
  const checked = Profiles.checkProfile(profile.effective, "threads.remote", { host });
  return checked.ok
    ? undefined
    : `Acting on ${host} needs the goatclaw threads.remote capability and a host the profile allows. ${checked.reason}`;
};
