import type { GoatBotAccent, GoatBotFaceInput } from "@goat/client-runtime/goatBot";
import { GoatBotFaceAvatar } from "./GoatBotFace";
import { useMobileGoatBotFace } from "./useMobileGoatBotFace";

export function GoatBotHeroFace(props: {
  readonly activity: GoatBotFaceInput["activity"];
  readonly conversation?: Parameters<typeof useMobileGoatBotFace>[1];
  readonly emoji?: string | null | undefined;
  readonly accent?: GoatBotAccent | null | undefined;
}) {
  const face = useMobileGoatBotFace(props.activity, props.conversation);
  return (
    <GoatBotFaceAvatar
      state={face.state}
      size={96}
      motion={null}
      emoji={props.emoji}
      accent={props.accent}
    />
  );
}
