import { entry } from "../entry.ts";

export const cloudMachineEntries = {
  "cloud_machine.list": entry({
    resource: "cloud_machine",
    verb: "list",
    name: "goat_cloud_machine_list",
    toolkit: "ssh",
    summary: "List cloud machines",
    description:
      "List the Boat cloud machines this environment manages. Each has a label, an SSH alias (boat-<sandbox id>) usable as host in goat_ssh_browse, goat_ssh_thread_launch and other host tools, its Boat state and its auto-stop time. A stopped (archived) machine must be resumed with goat_cloud_machine_resume before host tools reach it; browsing or launching on it resumes it. configured:false means no Boat API key is set in Settings → Connections. Machines bill the user's Boat account while they run.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "List cloud machines",
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
  "cloud_machine.create": entry({
    resource: "cloud_machine",
    verb: "create",
    name: "goat_cloud_machine_create",
    toolkit: "ssh",
    summary: "Create a cloud machine",
    description:
      "Create a Boat cloud machine that bills the user's Boat account, then make it an SSH host this environment can browse and launch threads on. Only create one when the user asked for a new machine. ttlSeconds is the auto-stop time after the last explicit use (60 to 2592000). The machine provisions in the background; its alias appears in goat_cloud_machine_list immediately and in goat_ssh_host_list once it is ready. Needs a caller allowed to change settings.",
    effect: "write",
    capability: "boat.start",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["approval"],
    annotations: {
      title: "Create a cloud machine",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "cloud_machine.stop": entry({
    resource: "cloud_machine",
    verb: "stop",
    name: "goat_cloud_machine_stop",
    toolkit: "ssh",
    summary: "Stop a cloud machine",
    description:
      "Stop a Boat cloud machine this environment manages. Its disk is saved as a snapshot (kept about 14 days) and billing stops; running processes end. Stopping is asynchronous: the result shows archiving until Boat finishes. Needs a caller allowed to change settings.",
    effect: "write",
    capability: "boat.start",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["approval"],
    annotations: {
      title: "Stop a cloud machine",
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
  "cloud_machine.resume": entry({
    resource: "cloud_machine",
    verb: "resume",
    name: "goat_cloud_machine_resume",
    toolkit: "ssh",
    summary: "Resume a cloud machine",
    description:
      "Resume a stopped Boat cloud machine this environment manages, wait until it accepts SSH (up to a few minutes), refresh its SSH address and host key, and restart its auto-stop time. Billing starts again. Needs a caller allowed to change settings.",
    effect: "write",
    capability: "boat.start",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["approval"],
    annotations: {
      title: "Resume a cloud machine",
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
} as const;
