import {
  InfoIcon,
  LightbulbIcon,
  MessageSquareWarningIcon,
  OctagonAlertIcon,
  StarIcon,
  TriangleAlertIcon,
} from "~/components/solar";

export const GITHUB_ALERT_PRESENTATIONS: Record<
  string,
  { label: string; Icon: typeof InfoIcon; borderClassName: string; titleClassName: string }
> = {
  insight: {
    label: "Insight",
    Icon: StarIcon,
    borderClassName: "border-info",
    titleClassName: "text-info",
  },
  note: {
    label: "Note",
    Icon: InfoIcon,
    borderClassName: "border-info/70",
    titleClassName: "text-info-foreground",
  },
  tip: {
    label: "Tip",
    Icon: LightbulbIcon,
    borderClassName: "border-success/70",
    titleClassName: "text-success-foreground",
  },
  important: {
    label: "Important",
    Icon: MessageSquareWarningIcon,
    borderClassName: "border-purple-500/70",
    titleClassName: "text-purple-600 dark:text-purple-400",
  },
  warning: {
    label: "Warning",
    Icon: TriangleAlertIcon,
    borderClassName: "border-warning/70",
    titleClassName: "text-warning-foreground",
  },
  caution: {
    label: "Caution",
    Icon: OctagonAlertIcon,
    borderClassName: "border-destructive/70",
    titleClassName: "text-destructive-foreground",
  },
};
