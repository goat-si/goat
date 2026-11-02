import type { EnvironmentProject, EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import type { ThreadListV2Status } from "./threadListV2";

interface StatusLabel {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly className: string;
  readonly iconTintClassName: string;
}
export const STATUS_LABEL_BY_STATUS: Partial<Record<ThreadListV2Status, StatusLabel>> = {
  approval: {
    label: "Approval",
    icon: "exclamationmark.shield",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
  },
  input: {
    label: "Input",
    icon: "questionmark.bubble",
    className: "text-adaptive-indigo-600-300",
    iconTintClassName: "accent-adaptive-indigo-600-300",
  },
  request: {
    label: "Request",
    icon: "person.crop.circle",
    className: "text-adaptive-fuchsia-600-300",
    iconTintClassName: "accent-adaptive-fuchsia-600-300",
  },
  working: {
    label: "Working",
    icon: "circle.dashed",
    className: "text-adaptive-sky-600-400",
    iconTintClassName: "accent-adaptive-sky-600-400",
  },
  waiting: {
    label: "Waiting",
    icon: "circle.dashed.inset.filled",
    className: "text-foreground-muted",
    iconTintClassName: "accent-foreground-muted",
  },
  failed: {
    label: "Failed",
    icon: "exclamationmark.circle",
    className: "text-danger-foreground",
    iconTintClassName: "accent-danger-foreground",
  },
  limited: {
    label: "Limited",
    icon: "exclamationmark.circle",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
  },
};
export const DONE_STATUS_LABEL: StatusLabel = {
  label: "Done",
  icon: "checkmark.circle",
  className: "text-adaptive-emerald-700-300",
  iconTintClassName: "accent-adaptive-emerald-700-300",
};

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

export function folderName(path: string | null | undefined): string | null {
  if (!path?.trim()) return null;
  const segments = path.split(/[\\/]+/).filter(Boolean);
  const last = segments.at(-1);
  return last === undefined || (segments.length === 1 && /^[a-z]:$/i.test(last)) ? null : last;
}

export function ThreadListV2WorktreeGlyph(props: {
  readonly thread: Pick<EnvironmentThreadShell, "worktreePath" | "branch">;
  readonly tintClassName: string;
}) {
  if (!props.thread.worktreePath?.trim()) return null;
  const folder = folderName(props.thread.worktreePath);
  return (
    <View
      accessibilityLabel={`Worktree: ${folder ?? props.thread.worktreePath}${props.thread.branch ? ` (${props.thread.branch})` : ""}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <SymbolView
        name="arrow.triangle.branch"
        size={11}
        type="monochrome"
        tintColorClassName={props.tintClassName}
      />
    </View>
  );
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
