import { useRef, type Ref } from "react";

import { PlusIcon } from "~/components/solar";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ComposerAttachInput({
  ref,
  addComposerAttachments,
  focusComposer,
}: {
  readonly ref: Ref<HTMLInputElement>;
  readonly addComposerAttachments: (files: File[]) => Promise<boolean>;
  readonly focusComposer: () => void;
}) {
  return (
    <input
      ref={ref}
      type="file"
      multiple
      className="hidden"
      onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        void addComposerAttachments(files).then((inserted) => {
          if (!inserted) focusComposer();
        });
      }}
    />
  );
}

export function ComposerAttachButton({ onOpenPicker }: { readonly onOpenPicker: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onPointerDown={(event) => event.preventDefault()}
            onClick={onOpenPicker}
            aria-label="Attach files"
          />
        }
      >
        <PlusIcon />
      </TooltipTrigger>
      <TooltipPopup>Attach files</TooltipPopup>
    </Tooltip>
  );
}

export function ComposerAttachAction(props: {
  readonly addComposerAttachments: (files: File[]) => Promise<boolean>;
  readonly focusComposer: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <ComposerAttachInput ref={input} {...props} />
      <ComposerAttachButton onOpenPicker={() => input.current?.click()} />
    </>
  );
}
