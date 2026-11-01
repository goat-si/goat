import { Button } from "../ui/button";

export function ComposerPromptLengthValidation({
  message,
  action,
}: {
  message: string | null;
  action?: { readonly label: string; readonly onClick: () => void } | null;
}) {
  if (!message) return null;

  return (
    <div className="flex items-center gap-2 px-3 pb-2 sm:px-4">
      <p
        role="alert"
        className="min-w-0 text-xs text-destructive"
        data-chat-composer-validation="prompt-length"
      >
        {message}
      </p>
      {action ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="shrink-0"
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
