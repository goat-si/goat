import {
  GOAT_MARK_HORNS_PATH,
  GOAT_MARK_HORNS_SOFTEN_WIDTH,
  GOAT_MARK_INK_BOX,
  GOAT_MARK_PEAK_PATH,
  GOAT_MARK_PEAK_WIDTH,
} from "@goat/shared/goatMark";
import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);
const { x, y, width, height } = GOAT_MARK_INK_BOX;

export function GoatWordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="GOAT"
      height={props.height}
      width={props.height * (width / height)}
      viewBox={`${x} ${y} ${width} ${height}`}
    >
      <ThemedPath
        d={GOAT_MARK_HORNS_PATH}
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={GOAT_MARK_HORNS_SOFTEN_WIDTH}
        strokeLinejoin="round"
      />
      <ThemedPath
        d={GOAT_MARK_PEAK_PATH}
        color={props.color}
        colorClassName={props.colorClassName}
        fill="none"
        stroke="currentColor"
        strokeWidth={GOAT_MARK_PEAK_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
