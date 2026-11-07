import { Atom } from "effect/reactivity";
import {
  presentProviderGoal,
  type RunStopPresentation,
} from "@goat/client-runtime/state/thread-execution";
import * as Dialog from "../../components/ui/Dialog";
import type { OrchestrationV2ProviderSession } from "@goat/contracts";
import type { EnvironmentConnectionPhase } from "@goat/client-runtime/connection";

export interface FloatingStatusAction {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}

export type FloatingWorkingStatus =
  | { readonly kind: "working"; readonly startedAt: string }
  | { readonly kind: "syncing"; readonly label: string }
  | { readonly kind: "compacting" }
  | {
      readonly kind: "child-input";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly onPress: () => void;
    }
  | {
      readonly kind: "background";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly waiting: boolean;
      readonly onPress: () => void;
      readonly action: FloatingStatusAction;
    }
  | {
      readonly kind: "lifecycle";
      readonly state: "snoozed" | "settled" | "woke";
      readonly label: string;
      readonly action: FloatingStatusAction;
    }
  | {
      readonly kind: "stop";
      readonly label: string;
      readonly unresponsive: boolean;
      readonly action: FloatingStatusAction | null;
    }
  | { readonly kind: "goal"; readonly label: string; readonly accessibilityLabel: string }
  | { readonly kind: "extension"; readonly label: string; readonly onPress: () => void }
  | { readonly kind: "preparing"; readonly label: string }
  | {
      readonly kind: "connection";
      readonly tone: "reconnecting" | "unavailable";
      readonly label: string;
      readonly onPress: () => void;
    };

export const NO_RUN_STOP_ATOM = Atom.make<RunStopPresentation | null>(null).pipe(
  Atom.withLabel("mobile-thread-run-stop:empty"),
);
export function goalFloatingStatus(
  goal: Parameters<typeof presentProviderGoal>[0],
): FloatingWorkingStatus {
  const display = presentProviderGoal(goal, false);
  return {
    kind: "goal",
    label: display.title,
    accessibilityLabel: `${display.title}: ${display.objective}`,
  };
}

export function piExtensionStatus(statuses: OrchestrationV2ProviderSession["extensionStatuses"]) {
  return statuses?.length
    ? {
        label: `Pi · ${statuses.map((status) => status.text).join(" · ")}`,
        onPress: () => Dialog.alert("Pi", statuses.map((status) => status.text).join("\n\n")),
      }
    : null;
}
export function piExtensionForControl(
  status: FloatingWorkingStatus | null,
  extension: ReturnType<typeof piExtensionStatus>,
) {
  return status !== null &&
    ["working", "compacting", "background", "goal", "lifecycle"].includes(status.kind)
    ? extension
    : null;
}

export function connectionFloatingStatus(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly environmentLabel: string | null;
  readonly onReconnect: () => void;
}): FloatingWorkingStatus | null {
  const environmentLabel = input.environmentLabel ?? "Environment";
  const unavailable = (label: string): FloatingWorkingStatus => ({
    kind: "connection",
    tone: "unavailable",
    label,
    onPress: input.onReconnect,
  });

  switch (input.connectionState) {
    case "connecting":
    case "reconnecting":
      return {
        kind: "connection",
        tone: "reconnecting",
        label:
          input.connectionError === null
            ? `Reconnecting to ${environmentLabel}...`
            : `Failed to connect. Retrying ${environmentLabel}...`,
        onPress: input.onReconnect,
      };
    case "offline":
      return unavailable("You are offline");
    case "unsupported":
      return unavailable("Client not supported");
    case "error":
      return unavailable(
        input.connectionError
          ? `Failed to connect to ${environmentLabel}: ${input.connectionError}`
          : `Failed to connect to ${environmentLabel}`,
      );
    case "available":
      return unavailable(`${environmentLabel} is not connected`);
    case "connected":
      return null;
  }
}
