import {
  BuiltInSkillName,
  resolveProjectBuiltInSkillEnabled,
  type ScreenBindingHints,
  type TurnCapability,
} from "@goat/contracts";
import { resolveBuiltInSkills } from "@goat/provider-core/server/builtinSkills/registry";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";

export const sameScreenBindingHints = (
  left: ScreenBindingHints | undefined,
  right: ScreenBindingHints | undefined,
): boolean => {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.browserRequested === right.browserRequested &&
    left.computerRequested === right.computerRequested &&
    left.appIds.length === right.appIds.length &&
    left.appIds.every((id, index) => id === right.appIds[index]) &&
    left.tabs.length === right.tabs.length &&
    left.tabs.every((tab, index) => {
      const other = right.tabs[index];
      return (
        other !== undefined &&
        tab.mentionId === other.mentionId &&
        tab.environmentId === other.environmentId &&
        tab.browserInstanceId === other.browserInstanceId &&
        tab.tabId === other.tabId &&
        tab.titleAtMention === other.titleAtMention &&
        tab.urlAtMention === other.urlAtMention
      );
    })
  );
};

interface ScreenSurfaceInput {
  readonly browserToolsAvailable: boolean;
  readonly usableThread: boolean;
  readonly computerUseAttached: boolean;
}

const attachedScreenSurfaces = (input: ScreenSurfaceInput): TurnCapability[] => [
  ...(input.browserToolsAvailable && input.usableThread ? (["browser"] as const) : []),
  ...(input.computerUseAttached ? (["computer-use"] as const) : []),
];

/**
 * Whether goat_screen_run is listed for the turn: the screen-code guide's own gate, before
 * Settings can switch the guide off, so the tool and its guide appear for the same surfaces.
 */
export const screenSurfaceAttached = (input: ScreenSurfaceInput): boolean =>
  resolveBuiltInSkills({ attached: attachedScreenSurfaces(input) }).active.includes("screen-code");

export const resolveAttachedScreenSkills = Effect.fn("ScreenSkills.resolveAttached")(function* (
  input: ScreenSurfaceInput & {
    readonly serverSettings: Option.Option<ServerSettings.ServerSettingsService["Service"]>;
    readonly projectId: Parameters<typeof resolveProjectBuiltInSkillEnabled>[1] | undefined;
    readonly requested: ReadonlyArray<TurnCapability> | undefined;
  },
) {
  const attached = attachedScreenSurfaces(input);
  const currentSettings = Option.isSome(input.serverSettings)
    ? yield* input.serverSettings.value.getSettings.pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Built-in screen guide unavailable: settings unreadable.", { cause }),
        ),
        Effect.orElseSucceed(() => undefined),
      )
    : undefined;
  const disabled = BuiltInSkillName.literals.filter(
    (name) =>
      (Option.isSome(input.serverSettings) && currentSettings === undefined) ||
      (currentSettings !== undefined &&
        input.projectId !== undefined &&
        !resolveProjectBuiltInSkillEnabled(currentSettings, input.projectId, name)),
  );
  return resolveBuiltInSkills({
    attached,
    ...(input.requested === undefined ? {} : { requested: input.requested }),
    disabled,
  }).active;
});
