export const isPreviewRefreshShortcut = (
  input: Electron.Input,
  platform: NodeJS.Platform,
): boolean =>
  input.type === "keyDown" &&
  input.key.toLowerCase() === "r" &&
  (platform === "darwin" ? input.meta && !input.control : input.control && !input.meta) &&
  !input.shift &&
  !input.alt;
