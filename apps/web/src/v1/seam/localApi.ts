// Seam for v1 apps/web/src/localApi.ts (goat 916b5ccc1b2): the browser branch of v1 createBrowserLocalApi
// (localApi.ts:15-40). GOAT 2 (Dev) opens links in the system browser through the Electron window-open handler.
import { isWebUrl } from "../browser/webUrl";

export interface Goat2LocalApi {
  readonly dialogs: {
    readonly confirm: (message: string, options?: { readonly variant?: "destructive" }) => Promise<boolean>;
  };
  readonly shell: { readonly openExternal: (url: string) => Promise<void> };
}

const api: Goat2LocalApi = {
  dialogs: {
    confirm: async (message) => window.confirm(message),
  },
  shell: {
    openExternal: async (url) => {
      if (!isWebUrl(url)) throw new Error("Unable to open link.");
      window.open(url, "_blank", "noopener,noreferrer");
    },
  },
};

export function ensureLocalApi(): Goat2LocalApi {
  return api;
}
