import { Pressable, Text } from "react-native";

/** A link to one of a task's work threads, held to the row's width so a long title truncates. */
export function MobileWorkThreadLink(props: {
  readonly link: { readonly text: string; readonly label: string };
  readonly disabled: boolean;
  /** The task screen mutes a closed link; Home's Show work keeps it underlined. */
  readonly mutedWhenDisabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.link.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-[44px] max-w-full shrink justify-center"
    >
      <Text
        numberOfLines={1}
        className={
          props.disabled && props.mutedWhenDisabled
            ? "text-foreground-muted"
            : "text-foreground underline"
        }
      >
        {props.link.text}
      </Text>
    </Pressable>
  );
}
