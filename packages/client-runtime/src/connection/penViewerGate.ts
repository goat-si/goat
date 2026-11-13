export const PEN_VIEWER_ENABLED = false;

export interface PenViewerPolicy {
  readonly enabled: boolean;
}

export const canUsePenViewer = (
  policy: PenViewerPolicy,
  desktop: boolean,
  shown: boolean,
): boolean => policy.enabled && desktop && shown;
