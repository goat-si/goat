import { useGT } from "gt-react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function useConnectionClipboardActions() {
  const gt = useGT();
  const { copyToClipboard: copyTraceIdToClipboard } = useCopyToClipboard<{ traceId: string }>({
    target: "trace ID",
    onCopy: ({ traceId }) => {
      toastManager.add({
        type: "success",
        title: gt("Trace ID copied"),
        description: traceId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not copy trace ID"),
          description: error.message,
        }),
      );
    },
  });
  const copyTraceId = (traceId: string) => {
    copyTraceIdToClipboard(traceId, { traceId });
  };
  const { copyToClipboard: copyMcpUrlToClipboard } = useCopyToClipboard<{ url: string }>({
    target: "MCP URL",
    onCopy: ({ url }) => {
      toastManager.add({
        type: "success",
        title: gt("MCP URL copied"),
        description: gt("Add it to an agent, e.g. {command}", {
          command: `claude mcp add --transport http goat ${url}`,
        }),
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not copy MCP URL"),
          description: error.message,
        }),
      );
    },
  });
  const copyMcpUrl = (url: string) => copyMcpUrlToClipboard(url, { url });
  return { copyTraceId, copyMcpUrl };
}
