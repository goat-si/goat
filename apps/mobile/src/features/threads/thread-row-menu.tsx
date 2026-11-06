import type { ComponentProps } from "react";
import { Platform } from "react-native";
import { Menu } from "../../components/ui/Menu";
import { layoutThreadRowMenu } from "./thread-row-menu-layout";

export function ThreadRowMenu(props: ComponentProps<typeof Menu>) {
  return <Menu {...props} actions={layoutThreadRowMenu(props.actions, Platform.OS === "ios")} />;
}
