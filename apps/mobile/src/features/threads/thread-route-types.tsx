import type { ReactNode } from "react";
import type { StaticScreenProps } from "@react-navigation/native";
import type { NewTaskDraftRouteParams } from "./NewTaskDraftRouteScreen";
import type { ThreadInspectorMode } from "./thread-inspector-content-stack";
import type { ThreadInspectorPresentation } from "./thread-inspector-preview";
import type { ThreadInspectorTarget } from "./thread-inspector-navigation";
import { useAdaptiveWorkspacePaneRole } from "../layout/AdaptiveWorkspaceLayout";

export interface ThreadInspectorSelection {
  readonly routeThreadIdentity: string | null;
  readonly mode: ThreadInspectorMode;
}

export function InspectorPaneRoleActivation() {
  useAdaptiveWorkspacePaneRole("inspector");
  return null;
}

type ThreadRouteScreenRouteProps = StaticScreenProps<{
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly draft?: NewTaskDraftRouteParams;
  readonly inspector?: ThreadInspectorTarget;
  readonly prompt?: string | string[];
}>;

export interface ThreadRouteScreenProps extends ThreadRouteScreenRouteProps {
  readonly inspectorPresentation?: ThreadInspectorPresentation;
  readonly onReturnToThread?: () => void;
  readonly renderInspector?: (headerInset: number) => ReactNode;
}
