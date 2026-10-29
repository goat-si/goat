import type { ActiveTurnComposerAction } from "@goat/client-runtime/state/composer-dispatch";
import { ComposerActionButton } from "../../components/ComposerToolbar";
import { Menu } from "../../components/ui/Menu";
import type { ComposerSendPresentation } from "./composerSendPresentation";

export const FOLLOW_UP_ACTION_LABEL = {
  queue: "Queue",
  steer: "Steer now",
  restart: "Restart turn",
} as const;
const subtitles = {
  queue: "Run after the current turn",
  steer: "Interrupt what the agent is doing",
  restart: "Start the turn over with this message",
} as const;

export function SendActionButton(props: {
  readonly size?: "regular" | "large";
  readonly accessibilityLabel: string;
  readonly presentation: ComposerSendPresentation;
  readonly disabled: boolean;
  readonly onSend: (followUp?: ActiveTurnComposerAction) => void;
}) {
  const { presentation } = props;
  const button = (
    <ComposerActionButton
      accessibilityLabel={props.accessibilityLabel}
      size={props.size}
      icon={presentation.icon}
      variant="primary"
      disabled={props.disabled}
      onPress={() => props.onSend()}
    />
  );
  if (!presentation.offersFollowUpChoice || presentation.action === null || props.disabled)
    return button;
  const actions = [presentation.action, presentation.alternate].filter(
    (action): action is ActiveTurnComposerAction => action !== null,
  );
  return (
    <Menu
      accessibilityLabel="Choose how to send this message"
      shouldOpenOnLongPress
      actions={actions.map((action) => ({
        id: action,
        title: FOLLOW_UP_ACTION_LABEL[action],
        subtitle: subtitles[action],
        state: action === presentation.action ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) =>
        props.onSend(nativeEvent.event as ActiveTurnComposerAction)
      }
    >
      {button}
    </Menu>
  );
}
