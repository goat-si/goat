import { msg } from "gt-react";
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
    label: msg("Supervised"),
    description: msg("Ask before commands and file changes."),
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: msg("Auto-accept edits"),
    description: msg("Auto-approve edits, ask before other actions."),
    icon: PenLineIcon,
  },
  auto: {
    label: msg("Auto"),
    description: msg("Supported providers approve routine actions; others still ask."),
    icon: SparklesIcon,
  },
  "full-access": {
    label: msg("Full access"),
    description: msg("Allow commands and edits without prompts."),
    icon: ShieldAlertIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
