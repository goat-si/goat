import type { RuntimeMode } from "@goat/contracts";
import {
  type IconComponent,
  LockIcon,
  PenLineIcon,
  ShieldAlertIcon,
  SparklesIcon,
} from "~/components/solar";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: IconComponent }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: ShieldAlertIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
