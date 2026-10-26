import { entry } from "../entry.ts";

export const cloudMachineEntries = {
  "cloud_machine.list": entry({
    resource: "cloud_machine",
    verb: "list",
    name: "goat_cloud_machine_list",
    toolkit: "ssh",
    summary: "List cloud machines",
    description:
      "List the Boat cloud machines managed by this environment. Listing does not resume stopped machines or extend their auto-stop timers; browsing or launching on a machine does.",
    guide:
      "Entries include a label, Boat state and configured auto-stop duration, plus an SSH alias formed as boat- followed by the sandbox id. Pass the alias to goat_ssh_browse, goat_ssh_thread_launch and other host tools. Explicit use can resume an archived machine without a separate goat_cloud_machine_resume call. configured:false means no Boat API key was found; configure it in Settings → Connections. Machines charge the user’s Boat account while running.",
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
      "Create a Boat cloud machine, billed to the user's Boat account, as an SSH host for browsing and thread launches; only when the user asked for a new machine. Provisioning continues after the response. Retry with the same clientRequestId; without one, check goat_cloud_machine_list and unconfirmedCreates after a lost response before retrying.",
    guide:
      "The user’s Boat account pays for the machine; create one only when requested. ttlSeconds is the auto-stop duration, from 60 to 2592000 seconds, restarted by explicit use rather than status checks. Its alias is added to the machine catalog before the response and is visible in goat_cloud_machine_list and goat_ssh_host_list even before SSH setup. The first browse, connection or launch waits for readiness and writes its SSH address and host key. Needs a live settings:write grant reauthorized for this call and the boat.start capability.",
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
    idempotency: "key",
    reconcile: "cloud_machine.list",
  }),
  "cloud_machine.stop": entry({
    resource: "cloud_machine",
    verb: "stop",
    name: "goat_cloud_machine_stop",
    toolkit: "ssh",
    summary: "Stop a cloud machine",
    description:
      "Ask Boat to stop a managed cloud machine: billing stops, running processes end, and its disk is kept as a snapshot for about 14 days. Stopping is asynchronous; read goat_cloud_machine_list for its state.",
    guide:
      "GOAT invalidates cached SSH state after Boat accepts the stop, then reads Boat's state again; when that read fails the result has presence unknown and state null. That state may already be archived; archiving is not guaranteed in every response. Needs a live settings:write grant reauthorized for this call.",
    effect: "write",
    capability: "boat.start",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["approval"],
    idempotencyReason: "Stopping a machine that is already stopping or stopped leaves it so.",
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
      "Resume a managed Boat cloud machine; billing starts again, so only when the user asked. Waits up to three minutes for SSH, refreshes its SSH address and host key, and restarts its auto-stop timer.",
    guide:
      "The operation also refreshes an already running machine and extends its timer. Readiness is based on Boat reporting ready, idle or running, followed by its SSH authorization endpoint; GOAT does not open a test SSH connection here. Needs a live settings:write grant reauthorized for this call and the boat.start capability.",
    effect: "write",
    capability: "boat.start",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["approval"],
    idempotencyReason:
      "Resuming a running machine only refreshes its address and restarts its auto-stop timer.",
    annotations: {
      title: "Resume a cloud machine",
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
} as const;
