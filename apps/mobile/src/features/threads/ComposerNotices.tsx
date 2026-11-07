import type { ServerProviderCompatibilityAdvisory } from "@goat/contracts";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

/** Notices above the composer: provider compatibility, model availability, and why send is blocked. */
export function ComposerNotices(props: {
  readonly advisory: ServerProviderCompatibilityAdvisory | undefined;
  readonly modelUnavailable: boolean;
  readonly onOpenModelSettings: () => void;
  readonly sendBlockedReason: string | null;
}) {
  const advisory =
    props.advisory?.message &&
    (props.advisory.status === "unsupported" || props.advisory.status === "broken")
      ? props.advisory
      : null;
  return (
    <>
      {advisory ? (
        <Text
          accessibilityRole={advisory.status === "broken" ? "alert" : undefined}
          accessibilityLiveRegion={advisory.status === "broken" ? "assertive" : "polite"}
          className={
            advisory.status === "broken"
              ? "bg-danger px-3 py-2 text-xs text-danger-foreground"
              : "px-3 py-2 text-xs text-foreground"
          }
        >
          {advisory.message}
        </Text>
      ) : null}
      {props.modelUnavailable ? (
        <Button
          label="Model unavailable. Open model settings."
          tone="text"
          onPress={props.onOpenModelSettings}
        />
      ) : null}
      {props.sendBlockedReason !== null ? (
        <Text
          accessibilityLiveRegion="polite"
          className="px-3 pb-1.5 text-xs text-foreground-muted"
          numberOfLines={2}
        >
          {props.sendBlockedReason}
        </Text>
      ) : null}
    </>
  );
}
