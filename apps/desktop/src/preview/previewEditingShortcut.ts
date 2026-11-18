export const isPreviewEditingShortcut = (
  input: Electron.Input,
  platform: NodeJS.Platform,
): boolean => {
  const isMac = platform === "darwin";
  if (isMac ? !input.meta || input.control : !input.control || input.meta) return false;

  const key = input.key.toLowerCase();
  // Option changes the DOM key for macOS Paste and Match Style (for example, to ◊).
  if (isMac && input.alt && input.shift && input.code === "KeyV") return true;
  if (key === "v" && input.shift) return input.alt === isMac;
  if (input.alt) return false;
  if (key === "z") return !input.shift || platform !== "win32";
  if (input.shift) return false;
  return (
    key === "a" ||
    key === "c" ||
    key === "v" ||
    key === "x" ||
    (key === "y" && platform === "win32")
  );
};
