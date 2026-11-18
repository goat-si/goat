export const PICTURE_IN_PICTURE_INITIAL_WIDTH = 480;
export const PICTURE_IN_PICTURE_INITIAL_HEIGHT = 320;
export const PICTURE_IN_PICTURE_MIN_WIDTH = 240;
export const PICTURE_IN_PICTURE_MIN_HEIGHT = 160;
export const PICTURE_IN_PICTURE_ASPECT_RATIO_EPSILON = 0.002;
export const fitPictureInPictureContentSize = (
  current: ReadonlyArray<number>,
  aspectRatio: number,
): readonly [width: number, height: number] => {
  const currentWidth = Math.max(1, current[0] ?? PICTURE_IN_PICTURE_INITIAL_WIDTH);
  const currentHeight = Math.max(1, current[1] ?? PICTURE_IN_PICTURE_INITIAL_HEIGHT);
  const currentArea = currentWidth * currentHeight;
  let width = Math.sqrt(currentArea * aspectRatio);
  let height = width / aspectRatio;
  const minimumScale = Math.max(
    1,
    PICTURE_IN_PICTURE_MIN_WIDTH / width,
    PICTURE_IN_PICTURE_MIN_HEIGHT / height,
  );
  width *= minimumScale;
  height *= minimumScale;
  return [Math.round(width), Math.round(height)];
};
