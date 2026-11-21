export class ThemeCssResourceError extends Error {
  override readonly name = "ThemeCssResourceError";
  constructor() {
    super("Images in theme CSS are not supported. Use the background setting instead.");
  }
}

export function isThemeCssResourceError(error: unknown): boolean {
  return error instanceof Error && error.name === "ThemeCssResourceError";
}
