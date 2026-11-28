// Where provider UI outside Providers sends the person (picker "Open Providers", "+"): App installs the opener.
let opener: ((target: { view?: "add"; instanceId?: string }) => void) | null = null;
export function setProvidersOpener(f: typeof opener) { opener = f; }
export function openProviders(target: { view?: "add"; instanceId?: string } = {}) { opener?.(target); }

