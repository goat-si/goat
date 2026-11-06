import type { MenuAction } from "@react-native-menu/menu";

export function layoutThreadRowMenu(actions: MenuAction[], nested: boolean): MenuAction[] {
  if (!nested || actions.length <= 5) return actions;
  return [
    ...actions.slice(0, 4),
    { id: "more", title: "More", image: "ellipsis.circle", subactions: actions.slice(4) },
  ];
}
