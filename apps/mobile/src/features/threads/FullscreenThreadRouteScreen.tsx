import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { InspectorContentScope } from "./thread-inspector-preview";
import { ThreadRouteScreen } from "./ThreadRouteScreen";

export function FullscreenThreadRouteScreen(
  props: StaticScreenProps<{
    readonly environmentId: string;
    readonly threadId: string;
  }>,
) {
  const navigation = useNavigation();
  return (
    <InspectorContentScope>
      <ThreadRouteScreen
        route={props.route}
        inspectorPresentation={{ onClose: () => navigation.goBack() }}
      />
    </InspectorContentScope>
  );
}
