import type { StandingInstructionsBlock } from "@goat/shared/standingInstructions";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";

/** What GOAT put in front of a launched thread's first message, collapsed until tapped. */
export function StandingInstructionsRow(props: { readonly block: StandingInstructionsBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-1">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? "Hide standing instructions" : "Show standing instructions"}
        hitSlop={4}
        onPress={() => setOpen((value) => !value)}
        className="flex-row items-center gap-1"
      >
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={10}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
        <Text className="font-goat-medium text-2xs text-foreground-muted">
          Standing instructions
        </Text>
        <Text className="text-2xs text-foreground-tertiary">{props.block.version}</Text>
      </Pressable>
      {open ? (
        <Text selectable className="text-xs text-foreground-muted">
          {props.block.text}
        </Text>
      ) : null}
    </View>
  );
}
