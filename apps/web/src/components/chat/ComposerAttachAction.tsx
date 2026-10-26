import { useRef } from "react";

import { PlusIcon } from "~/components/solar";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ComposerAttachAction({
  addComposerAttachments,
  focusComposer,
}: {
  readonly addComposerAttachments: (files: File[]) => Promise<boolean>;
  readonly focusComposer: () => void;
}) {
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          // Inserting a chip refocuses the editor after the draft renders;
          // focusing synchronously here would report the editor's stale text
          // over the prompt that was just written.
          void addComposerAttachments(files).then((inserted) => {
            if (!inserted) focusComposer();
          });
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => attachmentInputRef.current?.click()}
              aria-label="Attach files"
            />
          }
        >
          <PlusIcon />
        </TooltipTrigger>
        <TooltipPopup>Attach files</TooltipPopup>
      </Tooltip>
    </>
  );
}
