import { describe, expect, it } from "vite-plus/test";

import { type ActiveTurn, type ImageJob, trackImageJob } from "./adapterState.ts";

const job = (toolId: string): ImageJob => ({
  turn: {} as ActiveTurn,
  toolId,
  tool: { name: "experimental_image_generate", input: {} },
  previewed: false,
  path: `/tmp/${toolId}`,
  model: "gpt-image-1",
  status: "running",
});

describe("trackImageJob", () => {
  it("bounds settled image jobs to the newest 64 and never drops a running one", () => {
    const jobs = new Map<string, ImageJob>();
    trackImageJob(jobs, "long", job("long"));
    for (let index = 0; index < 100; index++) {
      trackImageJob(jobs, `job-${index}`, job(`job-${index}`));
      jobs.get(`job-${index}`)!.status = index % 2 === 0 ? "completed" : "error";
    }
    trackImageJob(jobs, "next", job("next"));

    const settled = [...jobs].filter(([, each]) => each.status !== "running").map(([id]) => id);
    expect(settled).toEqual(Array.from({ length: 64 }, (_, index) => `job-${index + 36}`));
    expect(jobs.get("long")?.status).toBe("running");
    expect(jobs.get("next")?.status).toBe("running");
  });

  it("keeps a settled job settled when its launch is replayed", () => {
    const jobs = new Map<string, ImageJob>();
    trackImageJob(jobs, "job", job("job"));
    jobs.get("job")!.status = "completed";
    trackImageJob(jobs, "job", job("job"));
    expect(jobs.get("job")?.status).toBe("completed");
  });
});
