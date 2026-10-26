import { useNavigation } from "@react-navigation/native";
import type { ComponentProps } from "react";
import { Platform } from "react-native";

import { ListRow } from "../../../components/ui/ListRow";
import {
  isGoatSettingsSheetTarget,
  type SettingsLegalDocumentTarget,
  type SettingsSheetTarget,
} from "./settings-sheet-targets";

export function SettingsRow(props: {
  readonly disabled?: boolean;
  readonly icon: ComponentProps<typeof ListRow>["icon"];
  readonly label: string;
  readonly value?: string;
  readonly valuePosition?: "below" | "trailing";
  readonly target?: SettingsSheetTarget;
  readonly fullScreenTarget?: SettingsLegalDocumentTarget;
  readonly onPress?: () => void;
}) {
  const navigation = useNavigation();
  const valueBelow =
    props.valuePosition === "below" ||
    (props.valuePosition === undefined && Platform.OS === "android");
  return (
    <ListRow
      icon={props.icon}
      label={props.label}
      description={valueBelow ? props.value : undefined}
      detail={valueBelow ? undefined : props.value}
      disabled={props.disabled}
      onPress={() => {
        const target = props.target;
        // TypeScript checks a union-valued route name only up to 25 members, so GOAT's
        // targets navigate in their own branch and upstream's list stays under the limit.
        if (target && isGoatSettingsSheetTarget(target)) {
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: target },
          });
        } else if (target) {
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: target },
          });
        } else if (props.fullScreenTarget) {
          navigation.navigate(props.fullScreenTarget);
        } else {
          props.onPress?.();
        }
      }}
    />
  );
}
