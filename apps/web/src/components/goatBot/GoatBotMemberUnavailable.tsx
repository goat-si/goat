import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";

/** A member bot's conversation whose bot list could not be read; it never opens as a coding thread. */
export function GoatBotMemberUnavailable({ onRetry }: { readonly onRetry: (() => void) | null }) {
  return (
    <Empty className="min-h-0 flex-1">
      <EmptyHeader className="max-w-md">
        <EmptyTitle>Couldn't load this bot</EmptyTitle>
        <EmptyDescription>
          {onRetry === null
            ? "Its computer isn't connected. This opens once GOAT reconnects."
            : "Check the connection to its computer, then try again."}
        </EmptyDescription>
      </EmptyHeader>
      {onRetry === null ? null : (
        <EmptyContent>
          <div className="flex justify-center">
            <Button size="sm" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          </div>
        </EmptyContent>
      )}
    </Empty>
  );
}
