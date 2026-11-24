import type { EnvironmentId, PullRequestLinkedThreadsResult } from "@goat/contracts";

export interface CommandPaletteLinkedThreads {
  readonly environmentId: EnvironmentId;
  readonly threads: PullRequestLinkedThreadsResult["threads"];
}

const COMMAND_PALETTE_OPEN_EVENT = "goat:open-command-palette";

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in";
  readonly query?: string;
  readonly linkedThreads?: CommandPaletteLinkedThreads;
}

export function openCommandPalette(detail?: CommandPaletteOpenDetail): void {
  window.dispatchEvent(
    new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, detail ? { detail } : undefined),
  );
}

export function onOpenCommandPalette(
  listener: (detail: CommandPaletteOpenDetail) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<CommandPaletteOpenDetail>).detail ?? {});
  };
  window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
  return () => window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
}

export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}

let paletteOpener: HTMLElement | null = null;

export function captureCommandPaletteOpener(): void {
  paletteOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

export function getCommandPaletteOpener(): HTMLElement | null {
  return document.activeElement?.closest("[data-command-palette]") ? paletteOpener : null;
}
