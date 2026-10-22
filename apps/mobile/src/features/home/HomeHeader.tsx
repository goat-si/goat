import { Toolbar } from "../../components/ui/Toolbar";
import { use } from "react";
import { useNavigation, type ParamListBase } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import type { HomeHeaderProps } from "./HomeHeader.types";
import { useMobileGoatBotModeButton } from "../goat-bot/useMobileGoatBotHomeMode";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

/**
 * The iOS thread list lives in the workspace, whose WorkspaceToolbar owns its header and search.
 * GOAT adds its own left toolbar buttons: Notes, and the GOAT Bot toggle.
 */
export function HomeHeader(props: HomeHeaderProps) {
  const botMode = useMobileGoatBotModeButton();
  const mode = props.homeMode ?? botMode.mode;
  const botKnown = props.botKnown ?? botMode.known;
  const toggleMode = props.onToggleHomeMode ?? botMode.toggle;
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  const primaryColumn = use(NativePrimaryColumnContext);
  const showsThreads = mode === "bot" && primaryColumn?.selectedThreadKey == null;
  return (
    <Toolbar placement="left">
      <Toolbar.Button
        accessibilityLabel="Open notes"
        icon="doc.text"
        onPress={() => navigation.navigate("Notes")}
      />
      {botKnown ? (
        <Toolbar.Button
          accessibilityLabel={showsThreads ? "Show threads" : "Show GOAT Bot"}
          icon={showsThreads ? "list.bullet" : "bubble.left.and.bubble.right"}
          onPress={toggleMode}
        />
      ) : null}
    </Toolbar>
  );
}
