import { migratingStorage } from "@goat/client-runtime/storage-migration";
const STORAGE_KEY = "goat:snap-shot-setup-resume:v1";
let startupChecked = false;

export function readSnapShotSetupResume(): { wasEnabled: boolean } | null {
  try {
    const value = migratingStorage(window.localStorage).getItem(STORAGE_KEY);
    if (value === "enabled" || value === "disabled") return { wasEnabled: value === "enabled" };
  } catch {}
  return null;
}

export function saveSnapShotSetupResume(wasEnabled: boolean): void {
  try {
    migratingStorage(window.localStorage).setItem(STORAGE_KEY, wasEnabled ? "enabled" : "disabled");
  } catch {
    // Permission setup still works when local storage is unavailable.
  }
}

export function clearSnapShotSetupResume(): void {
  try {
    migratingStorage(window.localStorage).removeItem(STORAGE_KEY);
  } catch {
    // Storage may be unavailable.
  }
}

// Check once per startup so opening System Settings cannot redirect later navigation.
export function shouldResumeSnapShotSetupOnStartup(): boolean {
  if (startupChecked) return false;
  startupChecked = true;
  return readSnapShotSetupResume() !== null;
}
