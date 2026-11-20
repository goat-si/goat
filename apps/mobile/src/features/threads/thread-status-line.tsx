import { Pressable, View, type ColorValue } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";

export interface ThreadStatusLineModel {
  readonly key: string;
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly onOpen?: () => void;
  readonly action: {
    readonly label: string;
    readonly accessibilityLabel: string;
    readonly disabled: boolean;
    readonly onPress: () => void;
  };
}

export function ThreadStatusLine({
  line,
  iconColor,
}: {
  readonly line: ThreadStatusLineModel;
  readonly iconColor: ColorValue;
}) {
  const body = (
    <>
      <SymbolView name={line.icon} size={13} tintColor={iconColor} type="monochrome" />
      <Text className="shrink font-goat-medium text-xs text-foreground-muted" numberOfLines={1}>
        {line.label}
      </Text>
    </>
  );
  return (
    <View className="mb-3 flex-row items-center gap-1.5 px-1 py-1">
      {line.onOpen ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={line.accessibilityLabel ?? line.label}
          onPress={line.onOpen}
          hitSlop={8}
          className="shrink flex-row items-center gap-1.5 active:opacity-70"
        >
          {body}
        </Pressable>
      ) : (
        <View
          accessible
          accessibilityLabel={line.accessibilityLabel ?? line.label}
          className="shrink flex-row items-center gap-1.5"
        >
          {body}
        </View>
      )}
      <Text className="text-xs text-foreground-muted">·</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={line.action.accessibilityLabel}
        accessibilityState={{ disabled: line.action.disabled }}
        disabled={line.action.disabled}
        onPress={line.action.onPress}
        hitSlop={8}
        className={`active:opacity-70 ${line.action.disabled ? "opacity-50" : ""}`}
      >
        <Text className="font-goat-medium text-xs text-foreground">{line.action.label}</Text>
      </Pressable>
    </View>
  );
}
