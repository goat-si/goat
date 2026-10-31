import { useAtomValue } from "@effect/atom-react";
import { createComputerUseHistoryCommand } from "@goat/client-runtime/state/computer-use-history";
import type {
  ComputerUseHistoryCursor,
  ComputerUseHistoryEntry,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import { useRef, useState } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ComputerUseHistoryRows } from "./ComputerUseHistoryRows";

const command = createComputerUseHistoryCommand(connectionAtomRuntime);

export function ComputerUseHistorySection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const canRead = useAtomValue(command.permissionAtom(props.environmentId));
  const request = useAtomCommand(command, { reportFailure: false });
  const [entries, setEntries] = useState<ReadonlyArray<typeof ComputerUseHistoryEntry.Type>>([]);
  const [cursor, setCursor] = useState<typeof ComputerUseHistoryCursor.Type | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const load = async () => {
    if (!canRead || pending.current || (loaded && cursor === null)) return;
    pending.current = true;
    setLoading(true);
    setFailed(false);
    await request({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        limit: 30,
        ...(cursor === null ? {} : { before: cursor }),
      },
    })
      .then((result) => {
        if (result._tag === "Success") {
          setEntries((previous) => [...previous, ...result.value.entries]);
          setCursor(result.value.nextCursor);
          setLoaded(true);
        } else setFailed(true);
      })
      .catch(() => {
        setFailed(true);
      })
      .finally(() => {
        pending.current = false;
        setLoading(false);
      });
  };
  return (
    <section aria-label="Computer use history">
      {entries.length > 0 ? (
        <ComputerUseHistoryRows entries={entries} />
      ) : loaded ? (
        <p>No input history.</p>
      ) : null}
      {failed ? <p role="alert">Could not load input history.</p> : null}
      {!loaded || cursor !== null ? (
        <Button
          variant="ghost"
          size="xs"
          disabled={!canRead || loading}
          onClick={() => void load()}
        >
          {loading ? "Loading…" : loaded ? "Load more" : "Show input history"}
        </Button>
      ) : null}
    </section>
  );
}
