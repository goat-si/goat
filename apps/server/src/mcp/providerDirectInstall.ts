import {
  EnvironmentAuthorizationError,
  type OrchestratorMcpFailure,
  type ProviderSyncInput,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as HubNodes from "../hubNodes/HubNodes.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { assertFullAccess, assertLiveCaller, readCaller } from "./threadAccess.ts";

const REFUSED =
  "Installing without a person's approval needs a live full-access thread in default mode.";

const refuse = (message: string) =>
  new EnvironmentAuthorizationError({ requiredScope: "providers:manage", message });

/**
 * Install-only, live full-access thread, saved machines, profile allows a remote launch there: such
 * a caller could already start an agent there that runs the same installer. Answers the check to
 * run again before each send, or undefined when a person must approve.
 */
export const directInstallCheck = Effect.fn("ProviderDirectInstall.check")(function* (
  input: Pick<ProviderSyncInput, "hosts" | "login">,
): Effect.fn.Return<
  Effect.Effect<void, EnvironmentAuthorizationError> | undefined,
  never,
  McpInvocationContext.McpInvocationContext | ThreadManagement.ThreadManagementService
> {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined || input.login !== false) return undefined;
  const hosts = input.hosts ?? [];
  const context = yield* Effect.context<
    McpInvocationContext.McpInvocationContext | ThreadManagement.ThreadManagementService
  >();
  const hub = yield* Effect.serviceOption(HubNodes.HubNodes);
  const profiles = yield* Effect.serviceOption(Profiles.PermissionProfiles);
  const allowed = (capability: "threads.launch" | "threads.remote", host?: string) =>
    Option.isNone(profiles)
      ? Effect.void
      : profiles.value.check(scope, capability, { host, runtimeMode: "full-access" }).pipe(
          Effect.mapError((error) => refuse(error.message)),
          Effect.flatMap((result) =>
            !result.ok
              ? Effect.fail(refuse(result.reason))
              : result.effective.enabled && result.effective.runtimeMode !== "full-access"
                ? Effect.fail(
                    refuse(`Profile ${result.effective.profile.id} runs below full access.`),
                  )
                : Effect.void,
          ),
        );
  const check = Effect.gen(function* () {
    const caller = yield* readCaller().pipe(Effect.mapError((error) => refuse(error.message)));
    const thread: Effect.Effect<void, OrchestratorMcpFailure> = assertLiveCaller(caller).pipe(
      Effect.andThen(assertFullAccess(caller, REFUSED)),
    );
    yield* thread.pipe(Effect.mapError((error) => refuse(error.message)));
    yield* allowed("threads.launch");
    if (hosts.length === 0) return;
    yield* Effect.forEach(hosts, (host) => allowed("threads.remote", host), { discard: true });
    if (Option.isNone(hub)) return yield* refuse("This server keeps no machine list.");
    const { nodes } = yield* hub.value.snapshot.pipe(
      Effect.mapError(() => refuse("This server's machine list could not be read.")),
    );
    const saved = new Set(
      nodes.flatMap((node) =>
        node.routes.map((route) =>
          route.target.kind === "linked" ? route.target.name : route.target.alias,
        ),
      ),
    );
    const unsaved = hosts.find((host) => !saved.has(host));
    if (unsaved !== undefined)
      return yield* refuse(`${unsaved} is not a machine saved in this server's connections.`);
  }).pipe(Effect.provideContext(context));
  return Exit.isSuccess(yield* Effect.exit(check)) ? check : undefined;
});
