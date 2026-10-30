import { formatWorkingDurationLabel } from "@goat/client-runtime/state/models";
import type { EnvironmentProject, EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useVisibleSecondClock } from "./use-visible-second-clock";

const SPINNER_SIZE = 13;
// The native small indicator is 20pt; scaled, it matches the 13pt status icons.
const SPINNER_SCALE = SPINNER_SIZE / 20;

/** The working status icon: a native indicator, animated off the JS thread like the system's own. */
export function ThreadListV2WorkingSpinner(props: { readonly tintClassName: string }) {
  return (
    <View
      style={{
        width: SPINNER_SIZE,
        height: SPINNER_SIZE,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <AppActivityIndicator
        accessibilityElementsHidden
        importantForAccessibility="no"
        size="small"
        colorClassName={props.tintClassName}
        style={{ transform: [{ scale: SPINNER_SCALE }] }}
      />
    </View>
  );
}

function folderName(path: string | null | undefined): string | null {
  if (!path?.trim()) return null;
  const segments = path.split(/[\\/]+/).filter(Boolean);
  const last = segments.at(-1);
  return last === undefined || (segments.length === 1 && /^[a-z]:$/i.test(last)) ? null : last;
}

/** The second line's lead, as the web sidebar shows it: the folder, then the launcher it came via. */
export function ThreadListV2RowOrigin(props: {
  readonly thread: Pick<EnvironmentThreadShell, "source">;
  readonly project: Pick<EnvironmentProject, "workspaceRoot" | "title"> | null;
  readonly className: string;
}) {
  const folder = folderName(props.project?.workspaceRoot) ?? props.project?.title ?? null;
  const launcher = props.thread.source.externalLauncher;
  const text = [folder, launcher ? `via ${launcher}` : null].filter(Boolean).join(" · ");
  return (
    <Text className={cn("text-xs", props.className)} numberOfLines={1}>
      {text}
    </Text>
  );
}

/** Elapsed time after a Working or Waiting label. */
export function ThreadListV2Duration(props: {
  readonly startedAt: string | null;
  sidebar: boolean;
}) {
  const startedAtMs = Date.parse(props.startedAt ?? "");
  const nowMs = useVisibleSecondClock(Number.isFinite(startedAtMs), {
    whileUnfocused: props.sidebar,
  });
  if (!Number.isFinite(startedAtMs)) return null;
  return ` ${formatWorkingDurationLabel(nowMs - startedAtMs)}`;
}
