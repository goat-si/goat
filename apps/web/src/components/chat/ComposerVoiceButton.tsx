import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ContextMenu,
  ContextMenuTrigger,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "../ui/menu";
import { useId, useState } from "react";
import type { EnvironmentId } from "@goat/contracts";
import type { EnvironmentVoiceRequestContext } from "@goat/client-runtime/voice-input";
import { VoiceModelDialog } from "../../speech/VoiceModelDialog";

export interface ComposerVoiceButtonProps {
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly environmentSpeech?: {
    readonly label: string;
    readonly selected: boolean;
    readonly destinations: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly label: string;
    }>;
    readonly enable: (id: EnvironmentId) => void;
    readonly disable: () => void;
    readonly environmentId: EnvironmentId;
    readonly canManage: boolean;
    readonly resolveContext: (id: EnvironmentId) => Promise<EnvironmentVoiceRequestContext | null>;
  };
}

const OPTIONS_HINT = "Right-click for options";

export function ComposerVoiceButton({
  disabled,
  onClick,
  environmentSpeech,
}: ComposerVoiceButtonProps) {
  const [modelsOpen, setModelsOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const hintId = useId();
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={disabled}
      aria-label="Record voice input"
      {...(environmentSpeech
        ? { "aria-haspopup": "menu" as const, "aria-describedby": hintId }
        : {})}
      onPointerDown={(event) => event.preventDefault()}
      // Lifting the finger after a long press clicks the button; that press opened the options.
      onClick={() => {
        if (!optionsOpen) onClick();
      }}
    />
  );
  const tooltip = (
    <Tooltip>
      <TooltipTrigger render={environmentSpeech ? <ContextMenuTrigger render={button} /> : button}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path strokeLinecap="round" d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4M9 22h6" />
        </svg>
      </TooltipTrigger>
      <TooltipPopup>
        Record voice input
        {environmentSpeech ? (
          <span className="block text-muted-foreground">{OPTIONS_HINT}</span>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
  if (!environmentSpeech) return tooltip;
  return (
    <>
      <ContextMenu open={optionsOpen} onOpenChange={setOptionsOpen} disabled={disabled}>
        {tooltip}
        <span id={hintId} hidden>
          Right-click or press Shift+F10 for options.
        </span>
        <MenuPopup align="end" side="top">
          <MenuRadioGroup
            value={environmentSpeech.selected ? environmentSpeech.environmentId : "existing"}
          >
            {environmentSpeech.destinations.map((destination) => (
              <MenuRadioItem
                key={destination.environmentId}
                value={destination.environmentId}
                closeOnClick
                onClick={() => environmentSpeech.enable(destination.environmentId)}
              >
                Transcribe on {destination.label} (sends audio)
              </MenuRadioItem>
            ))}
            {environmentSpeech.destinations.length === 0 ? (
              <MenuItem disabled>No permitted environment connected</MenuItem>
            ) : null}
            <MenuRadioItem value="existing" closeOnClick onClick={environmentSpeech.disable}>
              Use existing voice input
            </MenuRadioItem>
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem disabled={!environmentSpeech.canManage} onClick={() => setModelsOpen(true)}>
            Manage voice models
          </MenuItem>
        </MenuPopup>
      </ContextMenu>
      {modelsOpen ? (
        <VoiceModelDialog
          key={environmentSpeech.environmentId}
          open
          onOpenChange={setModelsOpen}
          environmentId={environmentSpeech.environmentId}
          label={environmentSpeech.label}
          canManage={environmentSpeech.canManage}
          resolveContext={environmentSpeech.resolveContext}
        />
      ) : null}
    </>
  );
}
