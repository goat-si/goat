// Seam for v1 apps/web/src/terminal/ghostty/surface.ts (goat 916b5ccc1b2). GOAT 2 has no in-app terminal in Part 2,
// so a terminal sign-in cannot be shown; creating the surface fails and v1's ProviderAuthTerminal says so
// ("Could not load the sign-in terminal. Cancel and retry sign-in.").
export type GhosttyTheme = Record<string, string>;

export interface GhosttyTerminalSurfaceOptions {
  readonly theme: GhosttyTheme;
  readonly font?: { readonly size: number };
  readonly onData: (data: string) => void;
  readonly onResize: (cols: number, rows: number) => void;
  readonly onSelectionChange: () => void;
  readonly beforeKey: (event: KeyboardEvent) => boolean;
  readonly onLinkActivate: (url: string) => void;
}

export class GhosttyTerminalSurface {
  static async create(_mount: HTMLElement, _options: GhosttyTerminalSurfaceOptions): Promise<GhosttyTerminalSurface> {
    throw new Error("GOAT 2 has no in-app terminal yet.");
  }
  write(_data: string): void {}
  resetAndWrite(_data: string): void {}
  dispose(): void {}
}
