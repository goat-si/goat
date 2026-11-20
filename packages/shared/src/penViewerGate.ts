/**
 * The Pen-native viewer: the desktop gateway, the route broker and native discovery. Closed until
 * the review in docs/internals/pen.md ("The Pen-native viewer") opens it together with the target.
 */
export const PEN_VIEWER_ENABLED: boolean = false;

export interface PenViewerPolicy {
  readonly enabled: boolean;
}
