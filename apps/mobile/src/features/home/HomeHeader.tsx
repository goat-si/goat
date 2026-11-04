import { Toolbar } from "../../components/ui/Toolbar";
import { useNavigation, type ParamListBase } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { HomeHeaderProps } from "./HomeHeader.types";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

/**
 * The iOS thread list lives in the workspace, whose WorkspaceToolbar owns its header and search.
 * GOAT adds its own left toolbar buttons: Notes, and the GOAT Bot toggle.
 */
export function HomeHeader(_props: HomeHeaderProps) {
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  return (
    <Toolbar placement="left">
      <Toolbar.Button
        accessibilityLabel="Open notes"
        icon="doc.text"
        onPress={() => navigation.navigate("Notes")}
      />
    </Toolbar>
  );
}
