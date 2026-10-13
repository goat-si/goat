import { MorphIcon as BaseMorphIcon, type MorphIconProps } from "morphicons/react";

/** Renders Solar icon data from `~/components/solar/nodes` and morphs between shapes when `icon` changes. */
export function MorphIcon({
  reducedMotion = "user",
  strokeWidth = 1.75,
  ...props
}: MorphIconProps) {
  return <BaseMorphIcon reducedMotion={reducedMotion} strokeWidth={strokeWidth} {...props} />;
}
