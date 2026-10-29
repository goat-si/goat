import type { ScopedThreadRef } from "@goat/contracts";
import { resolveAddressBarInput } from "@goat/shared/preview";
import { type RefObject, useRef, useState } from "react";

import { ExternalLinkIcon } from "~/components/solar";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "~/components/ui/autocomplete";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { useBrowserAddressDraftStore } from "./browserAddressDraftStore";
import {
  buildBrowserAddressSuggestions,
  type BrowserAddressSuggestion,
  type BrowserAddressTab,
} from "./browserAddressSuggestions";
import { PreviewFaviconIcon } from "./PreviewFaviconIcon";

export interface PreviewAddressBarProps {
  addressKey: string;
  threadRef: ScopedThreadRef;
  tabId: string | null;
  url: string;
  tabs: ReadonlyArray<BrowserAddressTab>;
  history: ReadonlyArray<{ url: string; title?: string }>;
  disabled?: boolean | undefined;
  inputRef?: RefObject<HTMLInputElement | null>;
  onSubmit: (url: string) => void;
  /** False means a result closed between rendering and selection. */
  onActivateTab: (tabId: string) => boolean;
  onOpenInBrowser?: (() => void) | undefined;
}

/** Mount keyed by addressKey so tab switches dismiss the old tab's popup. */
export function PreviewAddressBar(props: PreviewAddressBarProps) {
  const localInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = props.inputRef ?? localInputRef;
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const highlightedItemRef = useRef<BrowserAddressSuggestion | undefined>(undefined);
  const draft = useBrowserAddressDraftStore((state) => state.drafts.get(props.addressKey));
  const setDraft = useBrowserAddressDraftStore((state) => state.setDraft);
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const value = draft ?? props.url;
  const suggestions = buildBrowserAddressSuggestions({
    query: value,
    currentUrl: props.url,
    activeTabId: props.tabId,
    tabs: props.tabs,
    history: props.history,
  });

  const dismiss = () => {
    setOpen(false);
    inputRef.current?.blur();
  };
  const navigate = (url: string) => {
    if (props.disabled || !url.trim()) return;
    // Invalid input stays editable; a committed navigation may subsequently redirect.
    try {
      resolveAddressBarInput(url);
      setDraft(props.addressKey, undefined);
      props.onSubmit(url);
      dismiss();
    } catch {
      return;
    }
  };
  const choose = (suggestion: BrowserAddressSuggestion) => {
    if (props.disabled) return;
    if (suggestion.kind !== "tab") {
      navigate(suggestion.url);
    } else if (props.onActivateTab(suggestion.tabId)) {
      // Switching to a result leaves this tab's unsubmitted edit intact.
      dismiss();
    }
  };

  return (
    <form
      className="group/address min-w-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        navigate(value);
      }}
    >
      <Autocomplete
        items={suggestions}
        filter={null}
        value={value}
        onValueChange={(next, details) => {
          if (details.reason === "item-press") {
            const suggestion = suggestions.find((item) => item.url === next);
            if (suggestion) choose(suggestion);
          } else {
            setDraft(props.addressKey, next);
          }
        }}
        onItemHighlighted={(item) => {
          highlightedItemRef.current = item;
        }}
        itemToStringValue={(item) => item.url}
        open={open && focused && !props.disabled && suggestions.length > 0}
        onOpenChange={setOpen}
        openOnInputClick
      >
        <InputGroup ref={anchorRef} variant="ghost" className="h-7">
          <AutocompleteInput
            ref={inputRef}
            render={<InputGroupInput size="sm" nativeInput />}
            aria-label="Search or enter URL"
            data-workspace-focus-default
            onFocus={() => {
              setFocused(true);
              setOpen(true);
              queueMicrotask(() => inputRef.current?.select());
            }}
            onBlur={() => {
              setFocused(false);
              setOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                if (event.key === "Enter") event.preventDefault();
                event.preventBaseUIHandler();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                event.preventBaseUIHandler();
                setDraft(props.addressKey, undefined);
                dismiss();
              } else if (event.key === "Enter" && !highlightedItemRef.current) {
                // Base UI owns highlighted-item activation; submit plain input explicitly.
                event.preventDefault();
                event.preventBaseUIHandler();
                navigate(value);
              }
            }}
            placeholder="Search or enter URL"
            spellCheck={false}
            disabled={props.disabled}
            data-preview-url-input
            size="sm"
          />
          {props.onOpenInBrowser && !focused ? (
            <InputGroupAddon align="inline-end">
              <span className="pointer-events-none flex opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover/address:pointer-events-auto group-hover/address:opacity-100">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        type="button"
                        onClick={props.onOpenInBrowser}
                        aria-label="Open in system browser"
                      />
                    }
                  >
                    <ExternalLinkIcon />
                  </TooltipTrigger>
                  <TooltipPopup>Open in system browser</TooltipPopup>
                </Tooltip>
              </span>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        {/* At least as wide as the address bar; long results widen it up to the
            available space instead of overflowing a fixed-width popup. */}
        <AutocompletePopup anchor={anchorRef}>
          <AutocompleteList>
            {suggestions.map((suggestion) => (
              <AutocompleteItem key={suggestion.id} value={suggestion}>
                <PreviewFaviconIcon
                  threadRef={props.threadRef}
                  url={suggestion.url}
                  className="size-4"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{suggestion.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {suggestion.url}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {suggestion.kind === "tab"
                    ? "Switch to tab"
                    : suggestion.kind === "history"
                      ? "Recent"
                      : "Go"}
                </span>
              </AutocompleteItem>
            ))}
          </AutocompleteList>
        </AutocompletePopup>
      </Autocomplete>
    </form>
  );
}
