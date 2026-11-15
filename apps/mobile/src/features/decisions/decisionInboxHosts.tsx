import type { ReactNode } from "react";

// Interactive native host adapters preserve the real cards, body and list branches.
type HostProps = {
  children?: ReactNode;
  onPress?: () => void;
  onChangeText?: (value: string) => void;
  disabled?: boolean;
  editable?: boolean;
  value?: string;
  label?: string;
  accessibilityLabel?: string;
  testID?: string;
  accessibilityElementsHidden?: boolean;
};
function Box(props: HostProps) {
  return (
    <div data-testid={props.testID} hidden={props.accessibilityElementsHidden}>
      {props.children}
    </div>
  );
}
function TextHost(props: HostProps) {
  return <span>{props.children}</span>;
}
function PressHost(props: HostProps) {
  return (
    <button
      type="button"
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.children ?? props.label}
    </button>
  );
}
function InputHost(props: HostProps) {
  return (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value ?? ""}
      disabled={props.editable === false || props.disabled}
      onChange={(event) => props.onChangeText?.(event.currentTarget.value)}
    />
  );
}

export { Box, InputHost, PressHost, TextHost };
export type { HostProps };
