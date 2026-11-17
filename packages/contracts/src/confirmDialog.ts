export type ConfirmDialogVariant = "default" | "destructive";

export interface ConfirmDialogOptions {
  readonly variant?: ConfirmDialogVariant;
  /** Which button takes focus on open. Defaults to Cancel; destructive confirms always keep Cancel. */
  readonly initialFocus?: "confirm" | "cancel";
}
