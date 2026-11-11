import { GOAT_BOT_COLORS, goatBotAccent, sameBotColor } from "@goat/client-runtime/goatBot";
import { useRef, type KeyboardEvent } from "react";

import { CheckIcon } from "~/components/solar";
import { cn } from "~/lib/utils";

interface ColorOption {
  readonly name: string;
  readonly value: string | null;
}

const OPTIONS: ReadonlyArray<ColorOption> = [
  { name: "Neutral", value: null },
  ...GOAT_BOT_COLORS.map(({ name, value }) => ({ name, value })),
];

/**
 * A member bot's accent as named swatches. Arrow keys move the selection, Home and End jump to
 * the ends, and a check mark marks the chosen one so it never reads by color alone.
 */
export function GoatBotColorField({
  value,
  onChange,
  disabled = false,
}: {
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
  readonly disabled?: boolean;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const choose = (index: number) => {
    const option = OPTIONS[index];
    if (option === undefined) return;
    onChange(option.value);
    buttons.current[index]?.focus();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = Math.max(
      0,
      OPTIONS.findIndex((option) => sameBotColor(option.value, value)),
    );
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        choose((current + 1) % OPTIONS.length);
        return;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        choose((current - 1 + OPTIONS.length) % OPTIONS.length);
        return;
      case "Home":
        event.preventDefault();
        choose(0);
        return;
      case "End":
        event.preventDefault();
        choose(OPTIONS.length - 1);
        return;
      default:
        return;
    }
  };
  return (
    <div className="grid gap-1.5 text-sm">
      <span aria-hidden>Color</span>
      <div
        role="radiogroup"
        aria-label="Bot color"
        className="flex flex-wrap gap-2"
        onKeyDown={handleKeyDown}
      >
        {OPTIONS.map((option, index) => {
          const checked = sameBotColor(option.value, value);
          const accent =
            option.value === null ? null : goatBotAccent({ role: "member", color: option.value });
          return (
            <button
              key={option.name}
              ref={(element) => {
                buttons.current[index] = element;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={option.name}
              tabIndex={checked ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full border border-border outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:opacity-64",
                checked && "inset-ring-2 inset-ring-ring",
                option.value === null &&
                  "bg-goat-person-message text-goat-person-message-foreground",
              )}
              style={
                accent === null
                  ? undefined
                  : { backgroundColor: accent.background, color: accent.foreground }
              }
            >
              {checked ? <CheckIcon aria-hidden className="size-4" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
