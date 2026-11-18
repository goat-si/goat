import type { PermissionRuleset, Session } from "@opencode-ai/sdk/v2";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

import { OpenCodeRuntimeError } from "./OpenCodeRuntime.ts";
import {
  OPENCODE_GOAT_SUBAGENT_DENY_KEY,
  mergeOpenCodeResumePermission,
  openCodeInstalledChildPermission,
  openCodeOwnsSubagentDeny,
  openCodeRecordedPermissionBase,
  openCodeResumePermissionDiffers,
  withOpenCodeSubagentDeny,
} from "./permissionRules.ts";

interface OpenCodeDenyThread {
  nativeSessionId: string;
  permission: PermissionRuleset;
  metadata?: { readonly [key: string]: unknown } | undefined;
  subagentsDenied: boolean;
  permissionRefreshPending?: boolean;
  parentSubagent: { readonly parentState: OpenCodeDenyThread } | null;
}

export interface OpenCodePermissionUpdate {
  readonly permission: PermissionRuleset;
  readonly metadata?: { readonly [key: string]: unknown };
}

export const syncOpenCodeSubagentDeny = Effect.fn("OpenCodeAdapter.syncSubagentRules")(function* (
  state: OpenCodeDenyThread,
  subagentsOff: boolean,
  children: Iterable<OpenCodeDenyThread>,
  update: (
    sessionID: string,
    body: OpenCodePermissionUpdate,
  ) => Effect.Effect<unknown, OpenCodeRuntimeError>,
) {
  if (state.subagentsDenied !== subagentsOff) {
    const permission = withOpenCodeSubagentDeny(
      state.permission,
      state.subagentsDenied,
      subagentsOff,
    );
    const metadata = { ...state.metadata, [OPENCODE_GOAT_SUBAGENT_DENY_KEY]: subagentsOff };
    yield* update(state.nativeSessionId, { permission, metadata });
    Object.assign(state, { permission, metadata, subagentsDenied: subagentsOff });
  }
  // Children launch subagents too, so a new deny reaches each child session before the prompt.
  for (const child of children) {
    if (!isDescendant(child, state) || child.subagentsDenied === subagentsOff) continue;
    const permission = withOpenCodeSubagentDeny(
      child.permission,
      child.subagentsDenied,
      subagentsOff,
    );
    const metadata = { ...child.metadata, [OPENCODE_GOAT_SUBAGENT_DENY_KEY]: subagentsOff };
    const write = update(child.nativeSessionId, { permission, metadata }).pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          Object.assign(child, { permission, metadata, subagentsDenied: subagentsOff }),
        ),
      ),
    );
    // A failed relaxation keeps the child denied; the next turn tries again.
    yield* subagentsOff ? write : write.pipe(Effect.ignore({ log: true }));
  }
});

function isDescendant(child: OpenCodeDenyThread, parent: OpenCodeDenyThread): boolean {
  let owner = child.parentSubagent?.parentState;
  while (owner !== undefined && owner !== parent) owner = owner.parentSubagent?.parentState;
  return owner !== undefined;
}

export const refreshOpenCodeChildPermissions = Effect.fn("OpenCode.refreshChildPermissions")(
  function* (input: {
    readonly root: OpenCodeDenyThread;
    readonly children: Iterable<OpenCodeDenyThread>;
    readonly policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
    readonly subagentsOff: boolean;
    readonly previousParentBase: PermissionRuleset | undefined;
    readonly listNativeChildren?: (
      id: string,
    ) => Effect.Effect<ReadonlyArray<Session>, OpenCodeRuntimeError>;
    readonly update: (
      id: string,
      body: OpenCodePermissionUpdate,
    ) => Effect.Effect<unknown, OpenCodeRuntimeError>;
  }) {
    const known = new Set([input.root.nativeSessionId]);
    for (const child of input.children) {
      if (!isDescendant(child, input.root)) continue;
      known.add(child.nativeSessionId);
      const merged = openCodeInstalledChildPermission(
        child,
        input.policy,
        child.subagentsDenied,
        true,
      );
      if (openCodeResumePermissionDiffers(child, merged)) {
        yield* input.update(child.nativeSessionId, {
          permission: merged.permission,
          metadata: merged.metadata,
        });
        Object.assign(child, merged);
      }
    }
    const list = input.listNativeChildren;
    if (list === undefined) return;
    const seen = new Set([input.root.nativeSessionId]);
    const pending = [{ id: input.root.nativeSessionId, base: input.previousParentBase }];
    for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
      for (const child of yield* list(parent.id)) {
        if (seen.has(child.id)) continue;
        if (seen.size >= 1024) {
          return yield* new OpenCodeRuntimeError({
            operation: "session.children",
            detail: "OpenCode has too many descendants to refresh their permissions.",
          });
        }
        seen.add(child.id);
        pending.push({ id: child.id, base: openCodeRecordedPermissionBase(child) });
        if (known.has(child.id)) continue;
        const merged = openCodeInstalledChildPermission(
          child,
          input.policy,
          input.subagentsOff,
          true,
          parent.base,
        );
        if (openCodeResumePermissionDiffers(child, merged)) {
          yield* input.update(child.id, {
            permission: merged.permission,
            metadata: merged.metadata,
          });
        }
      }
    }
  },
);

export const installResumedOpenCodePermission = Effect.fn(
  "OpenCodeAdapter.installResumePermission",
)(function* (input: {
  readonly state: OpenCodeDenyThread;
  readonly session: {
    readonly permission?: PermissionRuleset | undefined;
    readonly metadata?: { readonly [key: string]: unknown } | undefined;
  };
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy | undefined;
  readonly subagentsOff: boolean | undefined;
  readonly failure: "pending" | "raise";
  readonly update: (
    sessionID: string,
    body: {
      readonly permission: PermissionRuleset;
      readonly metadata: { readonly [key: string]: unknown };
    },
  ) => Effect.Effect<unknown, OpenCodeRuntimeError>;
}) {
  if (input.session.permission !== undefined) input.state.permission = input.session.permission;
  if (input.session.metadata !== undefined) input.state.metadata = input.session.metadata;
  input.state.subagentsDenied = openCodeOwnsSubagentDeny(input.state);
  if (input.runtimePolicy === undefined) return;
  const merged = mergeOpenCodeResumePermission(
    input.state,
    input.runtimePolicy,
    input.subagentsOff,
  );
  if (!openCodeResumePermissionDiffers(input.state, merged)) {
    input.state.permissionRefreshPending = false;
    return;
  }
  const result = yield* input
    .update(input.state.nativeSessionId, {
      permission: merged.permission,
      metadata: merged.metadata,
    })
    .pipe(Effect.result);
  if (result._tag === "Failure") {
    if (input.failure === "raise") return yield* result.failure;
    input.state.permissionRefreshPending = true;
    return yield* Effect.logWarning(
      "OpenCode resume could not refresh GOAT permission rules; the next prompt will retry.",
      result.failure,
    );
  }
  Object.assign(input.state, {
    permission: merged.permission,
    metadata: merged.metadata,
    subagentsDenied: merged.subagentsDenied,
    permissionRefreshPending: false,
  });
});
