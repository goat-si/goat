import { Easing } from "react-native-reanimated";
import { USER_INPUT_TOGGLE_DURATION_MS } from "./pendingUserInputLayout";

export const USER_INPUT_TOGGLE_TIMING = {
  duration: USER_INPUT_TOGGLE_DURATION_MS,
  easing: Easing.out(Easing.cubic),
};
