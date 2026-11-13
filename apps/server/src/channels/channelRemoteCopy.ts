/** Fixed channel text for work on other machines. */

/** A name or host as shown in a refusal, cut so the instruction around it always fits. */
const capped = (value: string) => {
  const points = Array.from(value);
  return points.length > 80 ? points.slice(0, 79).join("") + "…" : value;
};

/** What the requester reads. Fixed text: remote error text never reaches a channel. */
export const REMOTE_COPY = {
  unknownHost: (host: string, hosts: ReadonlyArray<string>) =>
    "I can't send work to " +
    host +
    ". Which machine should run it? " +
    [...hosts, "this machine"].join(", "),
  unreachable: (host: string) =>
    "I can't reach " +
    host +
    " right now. Answer with this machine to run it here, or ask again later.",
  noProject: (host: string) =>
    "There is no project on " +
    host +
    " to work in yet. Add one in GOAT there, then answer with its name.",
  whichProject: (host: string, names: ReadonlyArray<string>) =>
    "Which project on " + host + " should I use? " + names.join(", "),
  projectGone: (host: string) =>
    "That project is no longer on " + host + ". Which one should I use?",
  launchRefused: (host: string) => "GOAT on " + host + " refused to start the work.",
  memoryUnsupported: (host: string) =>
    "GOAT on " +
    host +
    " can't apply the memory access this task may use. Update GOAT there and ask again.",
  launchUncertain: (host: string) =>
    "I can't tell whether the work started on " +
    host +
    ". Check its threads there before asking again.",
  launchIncomplete: (host: string) => "The work on " + host + " did not start a run.",
  reportsUnsupported: (host: string) =>
    "GOAT on " + host + " is too old to report back. Update it there and ask again.",
  lost: (host: string) => "The work on " + host + " is no longer reachable from here.",
  outage: (host: string) =>
    "I can't reach " + host + " right now. The work keeps running there; I'll reconnect.",
  reconnected: (host: string) => "Reconnected to " + host + ".",
  resumeBaseMissing: (host: string, fromHost: string) =>
    "The project on " +
    host +
    " doesn't have the commits the work from " +
    fromHost +
    " builds on. Push them, or fetch them on " +
    host +
    ", and ask again.",
  resumeRefConflict: (host: string) =>
    "The project on " + host + " already has a different copy of this work. Ask again.",
  resumeUnreadable: (host: string) =>
    "I couldn't place the copied work on " + host + ". Ask again, or pick another machine.",
  resumeUnreachable: (host: string) =>
    "I can't reach " + host + " to continue the work there. Ask again, or pick another machine.",
  staleMachineBack: (host: string) =>
    host +
    " is reachable again. It still has the earlier attempt's work; nothing from it reaches this task.",
  answerRefused: (host: string, answer: string) =>
    "The coding thread on " +
    host +
    " now runs above what this task may use, so I may not have passed on your answer (“" +
    answer +
    "”). Lower the thread’s mode there and answer again if it still matters, or answer in the thread.",
  inboxOverflow: (count: number) =>
    String(count) + " older progress reports from the other machine were dropped.",
  projectModelMissing: (host: string, project: string) =>
    "The model for " +
    project +
    " on " +
    host +
    " is not available there. Pick a default model for that project in GOAT on " +
    host +
    " and answer here.",
  defaultModelMissing: (host: string, project: string) =>
    "This machine's default model is not available on " +
    host +
    ". Pick a default model for " +
    project +
    " in GOAT on " +
    host +
    " and answer here.",
  /** The sender's access changed after they answered; whether an earlier send reached the host is unknown. */
  senderChanged: (name: string, host: string) =>
    "I may not have passed on an answer to " +
    capped(host) +
    ": " +
    capped(name) +
    "'s access changed after they answered. Answer again if it still matters, or answer in the thread there.",
  /** The requester's permission no longer covers the work; whether an earlier send reached the host is unknown. */
  requesterChanged: (host: string) =>
    "I may not have passed on your answer to " +
    capped(host) +
    ": the requester’s permission no longer covers this work. Open the thread in GOAT to check it.",
} as const;
