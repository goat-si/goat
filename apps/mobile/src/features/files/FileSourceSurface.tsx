import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { type ComponentProps, useState } from "react";
import { Platform } from "react-native";

import { SourceFileSurface } from "./SourceFileSurface";

export function FileSourceSurface(props: ComponentProps<typeof SourceFileSurface>) {
  const navigation = useNavigation();
  const [selection, setSelection] = useState<{
    readonly line: number;
    readonly active: boolean;
  } | null>(null);
  usePreventRemove(selection?.active === true, ({ data }) => {
    setSelection((value) => value && { ...value, active: false });
    if (data.action.type !== "GO_BACK" && data.action.type !== "POP")
      navigation.dispatch(data.action);
  });
  return (
    <SourceFileSurface
      {...props}
      initialLine={selection?.line ?? props.initialLine}
      selectable={selection?.active === true}
      onLongPressLine={
        Platform.OS === "android" ? (line) => setSelection({ line, active: true }) : undefined
      }
    />
  );
}
