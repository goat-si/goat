import { useGT } from "gt-react";
import type { PreviewSessionSnapshot } from "@goat/contracts";
import { canFindPreviewTab } from "./findAvailability";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "~/components/solar";
import { focusPreviewWebview } from "./focusPreviewWebview";
import { previewBridge } from "./previewBridge";

function PreviewFindBar({
  tabId,
  focusRequest,
  onClose,
}: {
  readonly tabId: string;
  readonly focusRequest: number;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ active: number; matches: number } | null>(null);

  // oxlint-disable-next-line goat/react-effect-budget -- A keyboard shortcut focuses the desktop search field.
  useEffect(() => {
    if (focusRequest === 0) return;
    input.current?.focus();
    input.current?.select();
  }, [focusRequest]);

  // oxlint-disable-next-line goat/react-effect-budget -- Own the guest's result listener and highlight for this mounted tab.
  useEffect(() => {
    const unsubscribe = previewBridge?.onFindResult?.((event) => {
      if (event.tabId !== tabId || !input.current?.value) return;
      setResult((previous) => ({
        active: event.activeMatchOrdinal >= 0 ? event.activeMatchOrdinal : (previous?.active ?? 0),
        matches: event.matches >= 0 ? event.matches : (previous?.matches ?? 0),
      }));
    });
    return () => {
      unsubscribe?.();
      void previewBridge?.stopFindInPage?.(tabId).catch(() => undefined);
    };
  }, [tabId]);

  const search = (text: string, forward: boolean, newSession: boolean) => {
    if (text)
      void previewBridge?.findInPage?.({ tabId, text, forward, newSession }).catch(() => undefined);
  };

  return (
    <div className="pointer-events-auto absolute top-2 right-2 z-40 w-[min(22rem,calc(100%-1rem))]">
      <InputGroup role="search" aria-label={gt("Find in page")} variant="popover">
        <InputGroupInput
          ref={input}
          type="search"
          aria-label={gt("Find in page")}
          placeholder={gt("Find in page")}
          maxLength={200}
          value={query}
          onChange={(event) => {
            const next = event.target.value;
            setQuery(next);
            setResult(null);
            if (next) search(next, true, true);
            else void previewBridge?.stopFindInPage?.(tabId).catch(() => undefined);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "Escape" || event.key === "Enter") {
              event.stopPropagation();
              event.preventDefault();
              if (event.key === "Escape") onClose();
              else search(query, !event.shiftKey, false);
            }
          }}
        />
        <InputGroupAddon align="inline-end">
          <span aria-live="polite" className="text-xs text-muted-foreground tabular-nums">
            {query && result
              ? gt("{active, number}/{matches, number}", {
                  active: result.matches ? result.active : 0,
                  matches: result.matches,
                })
              : null}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Go to previous match")}
            onClick={() => search(query, false, false)}
            disabled={!result?.matches}
          >
            <ChevronUpIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Go to next match")}
            onClick={() => search(query, true, false)}
            disabled={!result?.matches}
          >
            <ChevronDownIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Close page search")}
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

export function usePreviewFind(
  runtimeTabId: string | null,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null,
  nativeServerTab: boolean,
) {
  const tabId = canFindPreviewTab(snapshot, nativeServerTab) ? runtimeTabId : null;
  const [request, setRequest] = useState<{ tabId: string; count: number } | null>(null);
  if (request && request.tabId !== tabId) setRequest(null);
  return {
    open: tabId
      ? () => setRequest((previous) => ({ tabId, count: (previous?.count ?? 0) + 1 }))
      : undefined,
    bar:
      tabId && request?.tabId === tabId ? (
        <PreviewFindBar
          key={tabId}
          tabId={tabId}
          focusRequest={request.count}
          onClose={() => {
            setRequest(null);
            focusPreviewWebview(tabId);
          }}
        />
      ) : null,
  };
}
