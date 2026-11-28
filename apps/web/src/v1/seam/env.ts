// Seam for v1 apps/web/src/env.ts (goat 916b5ccc1b2), shared by lanes F and P2-M. v1 detects its own Electron preload
// (window.desktopBridge); GOAT 2 (Dev) has a different shell, so the v1 desktop paths stay off. Secrets stay off as in
// v1's default build (GOAT_FEATURE_SECRETS unset).
export const isElectron = false;
export const isSecretsFeatureEnabled = false;
