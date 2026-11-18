import type { BotProfile } from "@goat/contracts";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

/** The way back from a deleted member: run it, or why it cannot run now. */
export type MobileRestoreMember = (() => Promise<boolean>) | { readonly unavailable: string };

/**
 * A deleted member's conversation: what happened and, when the person may manage bots, the way
 * back. `onRestore` resolves to whether it worked; a failure shows its own alert. Offline it stays
 * in view, disabled, and says why.
 */
export function MobileDeletedBotBanner(props: {
  readonly member: BotProfile;
  readonly onRestore?: MobileRestoreMember | undefined;
}) {
  const [restoring, setRestoring] = useState(false);
  const { onRestore } = props;
  const unavailable = typeof onRestore === "object" ? onRestore.unavailable : null;
  const offline = unavailable !== null;
  return (
    <View accessibilityRole="alert" className="gap-2 border-b border-border px-4 py-3">
      <Text className="text-sm font-semibold text-foreground">{props.member.name} was deleted</Text>
      <Text className="text-sm text-foreground-muted">
        Its conversation is archived. Restore it to keep chatting here.
      </Text>
      {onRestore === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: restoring || offline }}
          disabled={restoring || offline}
          {...(offline ? { accessibilityHint: unavailable } : {})}
          onPress={() => {
            if (typeof onRestore !== "function") return;
            setRestoring(true);
            void onRestore().finally(() => setRestoring(false));
          }}
          className="min-h-[44px] min-w-[44px] justify-center self-start"
        >
          <Text
            className={
              offline
                ? "text-sm font-semibold text-foreground-muted"
                : "text-sm font-semibold text-foreground"
            }
          >
            Restore
          </Text>
        </Pressable>
      )}
    </View>
  );
}
