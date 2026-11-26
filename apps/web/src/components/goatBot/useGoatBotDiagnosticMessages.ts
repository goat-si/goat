import { useGT } from "gt-react";
import type { GoatBotDiagnosticMessages } from "@goat/client-runtime/goatBot";

export function useGoatBotDiagnosticMessages(): GoatBotDiagnosticMessages {
  const gt = useGT();
  return {
    down: gt("Not working"),
    attention: gt("Needs attention"),
    checking: gt("Checking…"),
    ready: gt("Ready"),
    checkingHome: gt("Checking the home machine…"),
    choosingHome: gt("Choosing a home machine…"),
    checkingModel: gt("Checking the model…"),
    chooseModel: gt("Choose another model"),
    openChat: gt("Open the chat"),
    loadFailed: gt("Couldn't load work"),
    loadingWork: gt("Loading work…"),
    noWork: gt("No open work"),
    answer: gt("Answer"),
    checkingSlack: gt("Checking Slack…"),
    slackCheckFailed: gt("Couldn't check Slack"),
    slackSettings: gt("Open Slack settings"),
    connectionFailed: gt("connection failed"),
    slackConnecting: gt("Slack is connecting…"),
    slackReconnecting: gt("Slack is reconnecting…"),
    slackConnected: gt("Slack connected"),
    homeRefused: (device) => gt("GOAT on {device} did not accept this device", { device }),
    moveHome: (device) => gt("Make {device} the home", { device }),
    offline: (device) => gt("Home machine is offline ({device})", { device }),
    unsupported: (device) => gt("{device} can't run GOAT Bot", { device }),
    home: (device) => gt("Answers on {device}", { device }),
    model: (model, provider) => gt("{model} on {provider}", { model, provider }),
    inherited: (bot, model) => gt("Uses {bot}'s current model ({model})", { bot, model }),
    unavailable: (model) => gt("Model unavailable: {model}", { model }),
    approvals: (count) => gt("{count} waiting for your approval", { count }),
    answers: (count) => gt("{count} waiting for your answer", { count }),
    running: (count) => gt("{count} running", { count }),
    queued: (count) => gt("{count} starting or queued", { count }),
    full: (count) => gt("Can't count open work: the newest {count} tasks are finished", { count }),
    atLeast: (summary) => gt("At least {summary}", { summary }),
    slackError: (error) => gt("Slack: {error}", { error }),
    deliveryFailed: (code) => gt("Last Slack reply failed ({code})", { code }),
  };
}
