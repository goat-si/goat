import { PROMPT_LINK_MAX_PROMPT_LENGTH } from "@goat/shared/promptLinks";
import { replaceComposerContextReferences } from "@goat/shared/composerContextReferences";
import type { ColorValue } from "react-native";

import { Menu } from "../../components/ui/Menu";
import { copyPromptLink } from "../prompt-links/prompt-link-actions";
import { CopyTextButton } from "./CopyTextButton";

const USER_MESSAGE_COPY_MENU_ACTIONS = [
  { id: "copy-prompt-link", title: "Copy prompt link", image: "link" },
];

export function UserMessageCopyButton(props: {
  readonly text: string;
  readonly onCopy: (() => Promise<void>) | undefined;
  readonly tintColor: ColorValue;
}) {
  const button = (
    <CopyTextButton
      accessibilityLabel="Copy message"
      text={props.text}
      onCopy={props.onCopy}
      tintColor={props.tintColor}
      buttonSize={28}
      iconSize={13}
    />
  );
  const linkText = replaceComposerContextReferences(props.text, (reference) => reference.label);
  if (linkText.length > PROMPT_LINK_MAX_PROMPT_LENGTH) return button;
  return (
    <Menu
      actions={USER_MESSAGE_COPY_MENU_ACTIONS}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "copy-prompt-link") void copyPromptLink(linkText);
      }}
      shouldOpenOnLongPress
    >
      {button}
    </Menu>
  );
}
