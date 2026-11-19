import { describe, expect, it, vi } from "vite-plus/test";
import { requestVoiceMicrophone } from "./requestVoiceMicrophone";

describe("microphone audio service recovery", () => {
  it("retries a failed capture once after the Linux audio service exits", async () => {
    const failure = new DOMException("busy", "NotReadableError");
    const stream = {} as MediaStream;
    const open = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(stream);
    const restart = vi.fn().mockResolvedValue(true);
    await expect(requestVoiceMicrophone(open, restart, () => true)).resolves.toBe(stream);
    expect(open).toHaveBeenCalledTimes(2);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("does not retry after cancellation while the audio service restarts", async () => {
    const failure = new DOMException("busy", "NotReadableError");
    const open = vi.fn().mockRejectedValue(failure);
    let finish: (value: boolean) => void = () => undefined;
    let current = true;
    const restart = () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    const result = requestVoiceMicrophone(open, restart, () => current);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    current = false;
    finish(true);
    await expect(result).rejects.toBe(failure);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("surfaces the original failure when no bridge is available", async () => {
    const failure = new DOMException("missing", "NotFoundError");
    const open = vi.fn().mockRejectedValue(failure);
    await expect(requestVoiceMicrophone(open, undefined, () => true)).rejects.toBe(failure);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
