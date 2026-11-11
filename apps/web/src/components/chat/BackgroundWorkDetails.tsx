import type { OrchestrationV2PendingBackgroundTask } from "@goat/contracts";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { ShellCommandBlock } from "./ShellCommandBlock";

export function BackgroundWorkDetails({
  tasks,
}: {
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
}) {
  return (
    <Dialog>
      <DialogTrigger render={<Button size="xs" variant="ghost" />}>Details</DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Background work</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5">
            {tasks.map((task) => (
              <section key={task.taskId} className="space-y-2 text-sm">
                <h3 className="font-medium">
                  {task.description && task.description !== task.command
                    ? task.description
                    : task.command
                      ? "Command"
                      : task.kind.replaceAll("_", " ")}
                </h3>
                {task.startedAt ? (
                  <p className="text-xs text-muted-foreground">
                    Started{" "}
                    <time dateTime={task.startedAt}>
                      {new Date(task.startedAt).toLocaleString()}
                    </time>
                  </p>
                ) : null}
                {task.command ? (
                  <div className="rounded-md border border-border bg-muted/20 p-3 font-mono text-xs whitespace-pre-wrap break-words">
                    <ShellCommandBlock command={task.command} />
                  </div>
                ) : null}
              </section>
            ))}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
