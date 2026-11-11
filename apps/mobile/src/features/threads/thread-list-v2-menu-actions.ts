import type { MenuAction } from "@react-native-menu/menu";

export const CARD_MENU_ACTIONS: MenuAction[] = [
  { id: "settle", title: "Settle", image: "checkmark" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

export const SLIM_MENU_ACTIONS: MenuAction[] = [
  { id: "unsettle", title: "Un-settle", image: "arrow.uturn.backward" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

export const SNOOZED_MENU_ACTIONS: MenuAction[] = [
  { id: "unsnooze", title: "Wake thread", image: "clock" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

export const LEGACY_MENU_ACTIONS: MenuAction[] = [
  { id: "archive", title: "Archive", image: "archivebox" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

export const MARK_UNREAD_MENU_ACTION: MenuAction = {
  id: "mark-unread",
  title: "Mark unread",
  image: "envelope.badge",
};

export function buildAutoSettleMenuActions(
  supported: boolean,
  autoSettleDisabledAt: string | null | undefined,
): MenuAction[] {
  if (!supported) return [];
  const enabled = autoSettleDisabledAt == null;
  return [
    {
      id: "auto-settle",
      title: "Auto-settle behavior",
      image: "timer",
      subactions: [
        { id: "auto-settle:enabled", title: "Enabled", state: enabled ? "on" : "off" },
        { id: "auto-settle:disabled", title: "Disabled", state: enabled ? "off" : "on" },
      ],
    },
  ];
}
