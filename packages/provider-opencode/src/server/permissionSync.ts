import type { PermissionRuleset, Session } from "@opencode-ai/sdk/v2";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OpenCodeRuntimeError } from "./OpenCodeRuntime.ts";
import {
  OPENCODE_GOAT_SUBAGENT_DENY_KEY,
  mergeOpenCodeResumePermission,
  openCodeClearPreviousPermissionBases,
  openCodeEffectivePermission,
  openCodeInstalledChildPermission,
  openCodeOwnsSubagentDeny,
  openCodeParentPermissionBases,
  openCodePermissionRulesEqual,
  openCodePreviousPermissionBases,
  openCodeRecordedPermissionBase,
  openCodeRememberPermissionBases,
  openCodeResumePermissionDiffers,
  type OpenCodeResumePermission,
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
  readonly permission?: PermissionRuleset;
  readonly metadata?: { readonly [key: string]: unknown };
}

type NativeChildren = (id: string) => Effect.Effect<ReadonlyArray<Session>, OpenCodeRuntimeError>;

export const retainOpenCodePreviousPermissionBase = Effect.fn(
  "OpenCode.retainPreviousPermissionBase",
)(function* (
  session: Parameters<typeof openCodeRecordedPermissionBase>[0],
  merged: OpenCodeResumePermission,
  confirmChildren?: Effect.Effect<ReadonlyArray<Session>, OpenCodeRuntimeError>,
) {
  const previous = openCodeRecordedPermissionBase(session);
  const next = openCodeRecordedPermissionBase(merged);
  if (
    previous === undefined ||
    next === undefined ||
    openCodePermissionRulesEqual(previous, next)
  ) {
    return merged;
  }
  const history = openCodePreviousPermissionBases(session.metadata);
  if (history.some((base) => openCodePermissionRulesEqual(base, previous))) return merged;
  // Inherited denies need their provenance even if the parent currently lists no children.
  if (
    history.length === 0 &&
    confirmChildren !== undefined &&
    previous.every((rule) => rule.action !== "deny")
  ) {
    const children = yield* confirmChildren.pipe(
      Effect.timeoutOption("10 seconds"),
      Effect.catch(() => Effect.succeedNone),
    );
    if (Option.isSome(children) && children.value.length === 0) return merged;
  }
  return openCodeRememberPermissionBases(merged, [...history, previous]);
});

export const resolveOpenCodeChildPermission = Effect.fn("OpenCode.resolveChildPermission")(
  function* (...input: Parameters<typeof openCodeInstalledChildPermission>) {
    const { discardedAllows, ...permission } = openCodeInstalledChildPermission(...input);
    if (discardedAllows > 0) {
      yield* Effect.logWarning(
        "Ignored OpenCode child permission allows outside the GOAT policy.",
        {
          count: discardedAllows,
        },
      );
    }
    return permission;
  },
);

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
    readonly scanNative: boolean;
    readonly listNativeChildren: NativeChildren;
    readonly update: (
      id: string,
      body: OpenCodePermissionUpdate,
    ) => Effect.Effect<unknown, OpenCodeRuntimeError>;
  }) {
    const known = new Map<string, OpenCodeDenyThread>();
    const clear = new Map<string, NonNullable<OpenCodePermissionUpdate["metadata"]>>();
    const remember = (id: string, metadata: OpenCodeDenyThread["metadata"]) => {
      const cleared = openCodeClearPreviousPermissionBases(metadata);
      if (cleared !== undefined) clear.set(id, cleared);
    };
    remember(input.root.nativeSessionId, input.root.metadata);
    for (const child of input.children) {
      const parent = child.parentSubagent?.parentState;
      if (parent === undefined || !isDescendant(child, input.root)) continue;
      known.set(child.nativeSessionId, child);
      const merged = yield* resolveOpenCodeChildPermission(
        child,
        input.policy,
        child.subagentsDenied,
        openCodeParentPermissionBases(parent),
      );
      if (openCodeResumePermissionDiffers(child, merged)) {
        const retained = yield* retainOpenCodePreviousPermissionBase(child, merged);
        yield* input.update(child.nativeSessionId, {
          permission: retained.permission,
          metadata: retained.metadata,
        });
        Object.assign(child, retained);
      }
      remember(child.nativeSessionId, child.metadata);
    }
    if (!input.scanNative && clear.size === 0) return;
    const seen = new Set([input.root.nativeSessionId]);
    const pending = [
      {
        id: input.root.nativeSessionId,
        bases: openCodeParentPermissionBases(input.root),
      },
    ];
    for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
      for (const child of yield* input.listNativeChildren(parent.id)) {
        if (seen.has(child.id)) continue;
        if (seen.size >= 1024) {
          return yield* new OpenCodeRuntimeError({
            operation: "session.children",
            detail: "OpenCode has too many descendants to refresh their permissions.",
          });
        }
        seen.add(child.id);
        const tracked = known.get(child.id);
        pending.push({ id: child.id, bases: openCodeParentPermissionBases(tracked ?? child) });
        if (tracked !== undefined) continue;
        const merged = yield* resolveOpenCodeChildPermission(
          child,
          input.policy,
          input.subagentsOff,
          parent.bases,
        );
        if (openCodeResumePermissionDiffers(child, merged)) {
          const retained = yield* retainOpenCodePreviousPermissionBase(child, merged);
          yield* input.update(child.id, {
            permission: retained.permission,
            metadata: retained.metadata,
          });
          remember(child.id, retained.metadata);
        } else {
          remember(child.id, child.metadata);
        }
      }
    }
    for (const [id, metadata] of clear) {
      yield* input.update(id, { metadata });
      const state = id === input.root.nativeSessionId ? input.root : known.get(id);
      if (state !== undefined) state.metadata = metadata;
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
  readonly listNativeChildren: NativeChildren;
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
  input.state.permission = openCodeEffectivePermission(input.state);
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
  const retained = yield* retainOpenCodePreviousPermissionBase(
    input.failure === "pending" ? input.session : input.state,
    merged,
    input.listNativeChildren(input.state.nativeSessionId),
  );
  const result = yield* input
    .update(input.state.nativeSessionId, {
      permission: retained.permission,
      metadata: retained.metadata,
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
    ...retained,
    permissionRefreshPending: false,
  });
});
