import { GoatWordmark } from "../GoatWordmark";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { OnboardingFooter, OnboardingHeader, OnboardingPopup } from "./OnboardingDialog";
import { OnboardingLink } from "./OnboardingLink";

/** Shown once per connected ChatGPT-shared provider profile; dismissing acknowledges it. */
export function ChatGptWelcomeDialog({
  open,
  providerName,
  environmentLabel,
  onDismiss,
}: {
  readonly open: boolean;
  readonly providerName: string | undefined;
  readonly environmentLabel: string | undefined;
  readonly onDismiss: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <OnboardingPopup>
        <OnboardingHeader
          host={environmentLabel}
          art={
            <OnboardingLink
              nodes={[
                { id: "chatgpt", icon: <OpenAI />, label: "ChatGPT", detail: "Your plan" },
                {
                  id: "goat",
                  icon: <GoatWordmark className="h-4 w-auto" />,
                  label: providerName ?? "Codex",
                  detail: "in GOAT",
                },
              ]}
            />
          }
          title="Your ChatGPT plan is connected"
          description="Eligible usage in GOAT uses your ChatGPT plan. Manage shared usage and credits in ChatGPT."
        />
        <OnboardingFooter>
          <ChatGptUsageButton />
          <Button onClick={onDismiss}>Continue</Button>
        </OnboardingFooter>
      </OnboardingPopup>
    </Dialog>
  );
}
