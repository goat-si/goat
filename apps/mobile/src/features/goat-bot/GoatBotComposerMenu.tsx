import type { MenuAction } from "@react-native-menu/menu";
import { useState, type ReactNode } from "react";
import { Pressable } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import {
  goatBotAttachmentPick,
  type GoatBotAttachmentPickTarget,
} from "./GoatBotComposerAttachments";

const DISABLED_REASON = "Opens once this chat can send messages again.";

/**
 * The bot chat's +: photos, files when the server takes them, and New routine while the chat can
 * send. A task's own screen keeps its attach button, since what is written there goes to the task.
 */
export function GoatBotComposerMenu(props: {
  /**
   * The chat is on screen and the app in front. Otherwise the menu is taken down, so an open one
   * closes: Android draws it in an overlay above every screen, which would outlive the chat.
   */
  readonly shown: boolean;
  readonly disabled: boolean;
  /** Where picked photos and files go; null when the server takes none. */
  readonly attach: GoatBotAttachmentPickTarget | null;
  readonly onNewRoutine?: (() => void) | undefined;
}) {
  const { scale } = useAndroidControlSizing();
  const pick = props.attach ? goatBotAttachmentPick(props.attach) : null;
  const actions: MenuAction[] = [
    ...(pick ? [{ id: "photos", title: "Photo Library", image: "photo" }] : []),
    ...(pick && props.attach?.maxUploadBytes !== null
      ? [{ id: "files", title: "Choose Files", image: "folder" }]
      : []),
    ...(props.onNewRoutine ? [{ id: "routine", title: "New routine", image: "clock" }] : []),
  ];
  const button = (
    <Pressable
      accessibilityLabel="Add to message"
      accessibilityRole="button"
      accessibilityHint={props.disabled ? DISABLED_REASON : undefined}
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
    >
      <SymbolView
        name="plus"
        size={Math.round(20 * scale)}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );
  // A chat that cannot send keeps today's dimmed + where the server takes attachments.
  if (props.disabled) return props.attach ? button : null;
  if (actions.length === 0) return null;
  if (!props.shown) return button;
  return (
    <OpenableMenu
      actions={actions}
      onAction={(id) => {
        if (id === "photos") void pick?.("media");
        else if (id === "files") void pick?.("files");
        else if (id === "routine") props.onNewRoutine?.();
      }}
    >
      {button}
    </OpenableMenu>
  );
}

/** Mounted only while the menu can open, so a menu taken down never comes back marked open. */
function OpenableMenu(props: {
  readonly actions: MenuAction[];
  readonly onAction: (id: string) => void;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Menu
      accessible
      accessibilityLabel="Add to message"
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      actions={props.actions}
      onOpenMenu={() => setExpanded(true)}
      onCloseMenu={() => setExpanded(false)}
      onPressAction={({ nativeEvent }) => props.onAction(nativeEvent.event)}
    >
      {props.children}
    </Menu>
  );
}
