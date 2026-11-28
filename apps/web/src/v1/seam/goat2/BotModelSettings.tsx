// Settings > GOAT Bot, Model row (Paper board 1QYE-2): v1's settings section and row (components/settings/
// settingsLayout.tsx) with the GOAT 2 model picker. v1's goat-bot page has more rows (reply style, notes); those belong
// to the bot runtime (lane P2-E) and arrive with it. The choice is sent with change_thread on the bot's thread.
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { AnchoredToastProvider, ToastProvider } from "../../components/ui/toast";
import { Goat2ModelPicker } from "./Goat2ModelPicker";

export interface BotModelSettingsProps {
  botName: string;
  instanceId: string;
  model: string;
  /** Null until the bot has a thread to change. */
  onChange: ((selection: { instanceId: string; model: string }) => void) | null;
  /** The host's refusal of the last change. */
  error?: string | null;
}

export function BotModelSettings(props: BotModelSettingsProps) {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <SettingsPageContainer>
          <SettingsSection title={props.botName}>
            <SettingsRow
              title="Model"
              description={props.error
                ? <span role="alert" className="text-destructive-foreground">{props.error}</span>
                : props.onChange ? `Used for ${props.botName}'s next turn` : `Send ${props.botName} a first message, then pick its model here`}
              control={
                <Goat2ModelPicker instanceId={props.instanceId} model={props.model} popupAlign="end" ariaLabel={`${props.botName} model: ${props.model}`}
                  disabled={props.onChange === null} onChange={(s) => props.onChange?.(s)} />
              }
            />
          </SettingsSection>
        </SettingsPageContainer>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}
