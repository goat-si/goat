import { View } from "react-native";
import { AppBar } from "../../components/ui/AppBar";
import { EmptyState } from "../../components/ui/EmptyState";

export function FilesUnavailable({
  title = "Files unavailable",
  detail = "This thread does not have an active workspace path.",
  onBack,
}: {
  readonly title?: string;
  readonly detail?: string;
  readonly onBack: () => void;
}) {
  return (
    <View className="flex-1 bg-sheet">
      <AppBar title="Files" onBack={onBack} sidebar={false} />
      <View className="flex-1 items-center justify-center px-6">
        <EmptyState title={title} detail={detail} />
      </View>
    </View>
  );
}
