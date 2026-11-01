import { useWindowDimensions } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import {
  ModelRowContent,
  ChoiceRowContent,
  type ModelRowProps,
  type ChoiceRowProps,
} from "./ThreadSettingsRows.shared";

function SelectedCheckmark(props: { readonly selected: boolean }) {
  return props.selected ? (
    <SymbolView
      name="checkmark"
      size={16}
      tintColorClassName="accent-icon"
      type="monochrome"
      weight="semibold"
    />
  ) : null;
}

export function ModelRow(props: ModelRowProps) {
  // Large text wraps model names instead of cutting them to a few letters.
  const { fontScale } = useWindowDimensions();
  return (
    <ModelRowContent
      {...props}
      labelNumberOfLines={fontScale > 1.2 ? 0 : 1}
      trailingSelection={<SelectedCheckmark selected={props.selected} />}
    />
  );
}

export function ChoiceRow(props: ChoiceRowProps) {
  return (
    <ChoiceRowContent
      {...props}
      trailingSelection={<SelectedCheckmark selected={props.selected} />}
    />
  );
}
