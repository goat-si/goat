import { View } from "react-native";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { AppText as Text } from "../../components/ui/AppText";

export function MessageAttachmentUnknown(props: { readonly name: string }) {
  return (
    <View className="flex-row items-center gap-2 py-1">
      <PierreEntryIcon path={props.name} kind="file" size={16} />
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        {props.name}
      </Text>
    </View>
  );
}
