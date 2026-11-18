import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "~/components/solar";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function GoatBotReplyCopy({
  text,
  select,
  release,
}: {
  readonly text: string;
  readonly select: (owner: { clear: () => void }) => void;
  readonly release: (owner: { clear: () => void }) => void;
}) {
  const [selected, setSelected] = useState(false);
  const mounted = useRef(true);
  const [owner] = useState(() => ({ clear: () => setSelected(false) }));
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1200,
    onCopy: () => {
      if (!mounted.current) return;
      select(owner);
      setSelected(true);
    },
    onError: () => toastManager.add({ type: "error", title: "Could not copy reply" }),
  });
  // oxlint-disable-next-line goat/react-effect-budget -- Release this row's selection when it unmounts.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      release(owner);
    };
  }, [release, owner]);
  const copied = selected && isCopied;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={copied ? "Copied" : "Copy"}
            onClick={() => copyToClipboard(text, undefined)}
          />
        }
      >
        {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
      </TooltipTrigger>
      <TooltipPopup>{copied ? "Copied" : "Copy"}</TooltipPopup>
    </Tooltip>
  );
}
