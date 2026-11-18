import { useAtomValue } from "@effect/atom-react";
import type { PullRequestDetail } from "@goat/contracts";
import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";
import Animated from "react-native-reanimated";
import { Chip } from "../../components/ui/Chip";
import { AppText as Text } from "../../components/ui/AppText";
import { composerPullRequests } from "../../state/pull-requests";
import { pullRequestTarget as requestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { pullRequestLabelColor } from "./pullRequestList";
import { PR_ROW_LAYOUT } from "./pullRequestAnimations";

export function PullRequestLabels(props: {
  readonly pr: PullRequestDetail;
  readonly params: PullRequestParams;
}) {
  const navigation = useNavigation();
  const connected = usePullRequestConnected(props.params.environmentId);
  const canWrite = useAtomValue(
    composerPullRequests.setLabels.permissionAtom(requestTarget(props.params).environmentId),
  );
  const editable =
    connected &&
    canWrite &&
    props.pr.capabilities.labels === true &&
    props.pr.viewerPermissions.labels !== false;
  if (!props.pr.labels.length && !editable) return null;
  return (
    <Animated.View layout={PR_ROW_LAYOUT} className="flex-row flex-wrap gap-2">
      {props.pr.labels.map((label) => {
        const color = pullRequestLabelColor(label.color);
        // Tinted like the list row's label pills, at the overview's chip size.
        return (
          <View
            key={label.name}
            className="max-w-full flex-row items-center gap-1.5 rounded-2xl bg-grouped-card px-3 py-1"
            style={color ? { backgroundColor: `${color}20` } : undefined}
          >
            {color ? (
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
            ) : null}
            <Text textRole="caption" className="shrink text-foreground-muted" numberOfLines={1}>
              {label.name}
            </Text>
          </View>
        );
      })}
      {editable ? (
        <Chip
          label={props.pr.labels.length ? "Edit" : "Add labels"}
          icon="tag"
          size="small"
          accessibilityLabel="Edit labels"
          onPress={() => navigation.navigate("PullRequestLabels", props.params)}
        />
      ) : null}
    </Animated.View>
  );
}
