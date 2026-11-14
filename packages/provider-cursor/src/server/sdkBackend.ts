const PRODUCTION_BACKEND = "https://api2.cursor.sh";
let initializedBackend: string | undefined;

export const normalizeSdkBackend = (backend: string | undefined) =>
  (backend || PRODUCTION_BACKEND).replace(/\/+$/, "");

export const currentSdkBackend = () => normalizeSdkBackend(process.env.CURSOR_BACKEND_URL);
export const currentCloudSdkBackend = () =>
  process.env.CURSOR_BACKEND_URL ?? "https://api.cursor.com";
export const cloudSdkBackendMatches = () => currentCloudSdkBackend() === "https://api.cursor.com";
export const bindSdkBackend = (backend: string) => {
  initializedBackend ??= backend;
};
export const sdkBackendMatches = (backend?: string) => {
  const selected = normalizeSdkBackend(backend);
  return (
    selected === currentSdkBackend() &&
    (initializedBackend === undefined || selected === initializedBackend)
  );
};
