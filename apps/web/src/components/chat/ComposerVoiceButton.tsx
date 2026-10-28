import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ComposerVoiceButtonProps {
  readonly disabled?: boolean;
  readonly onClick: () => void;
}

export function ComposerVoiceButton({ disabled, onClick }: ComposerVoiceButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            aria-label="Record voice input"
            onPointerDown={(event) => event.preventDefault()}
            onClick={onClick}
          />
        }
      >
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
      <TooltipPopup>Record voice input</TooltipPopup>
    </Tooltip>
  );
}
