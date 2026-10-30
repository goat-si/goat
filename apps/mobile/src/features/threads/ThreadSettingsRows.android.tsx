import { useWindowDimensions } from "react-native";

import { RadioIndicator } from "../../components/ui/RadioIndicator";
import {
  ModelRowContent,
  ChoiceRowContent,
  type ModelRowProps,
  type ChoiceRowProps,
} from "./ThreadSettingsRows.shared";

export function ModelRow(props: ModelRowProps) {
  // Large text wraps model names instead of cutting them to a few letters.
  const { fontScale } = useWindowDimensions();
  return (
    <ModelRowContent
      {...props}
      labelNumberOfLines={fontScale > 1.2 ? 0 : 2}
      minimumHeight={56}
      selectedClassName={props.selected ? "bg-secondary" : undefined}
      leadingSelection={<RadioIndicator selected={props.selected} />}
    />
  );
}

export function ChoiceRow(props: ChoiceRowProps) {
  return (
    <ChoiceRowContent
      {...props}
      minimumHeight={56}
      leadingSelection={<RadioIndicator selected={props.selected} />}
    />
  );
}
