# Listing measurement

**Reference, not paired**: numbers, no verdict. One arm (claude-full).

Campaigns cmvlj9q1w, cmvljdsg6, cmvljfbrj, cmvljgqtk, cmvljhz77, cmvljj9fn, cmvljkl38, cmvljlw90, cmvljn8ny, cmvljoxy2, cmvljq2r0.

Model turns are a range: tool rounds + 1 to tool calls + 1. Medians use successful clean runs; a verdict needs 10 of them per arm. Result bytes are the compact JSON the server returned to the run's tool calls.

## First prompt (context-budget.ts)

Commit 0a2948fa4: 201 tools, 213364 model-facing listing bytes.

| harness           | instructions | first prompt | every later turn |
| ----------------- | ------------ | ------------ | ---------------- |
| Codex (code mode) | 5952         | 219316       | 0                |
| Claude            | 4941         | 218305       | 0                |
| OpenCode          | 4957         | 218321       | 0                |
| Cursor            | 5061         | 218425       | 276              |
| ACP               | 5947         | 219311       | 166              |
| Pi                | 4679         | 218043       | 0                |

## read-control (no_gain): not_run

- the baseline has no clean runs

| arm         | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls | median failed calls | median result bytes | median wall time |
| ----------- | ---- | ------------ | ------ | ------------ | ---------- | ------------------ | ----------------- | ------------------- | ------------------- | ---------------- |
| claude-full | 0    | 0            | 0      | -            | 0          | - to -             | -                 | -                   | -                   | -                |

## wait-running (reduces): not_run

- the baseline has no clean runs

| arm         | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls | median failed calls | median result bytes | median wall time |
| ----------- | ---- | ------------ | ------ | ------------ | ---------- | ------------------ | ----------------- | ------------------- | ------------------- | ---------------- |
| claude-full | 0    | 0            | 0      | -            | 0          | - to -             | -                 | -                   | -                   | -                |

## fan-out-review (reduces): baseline_only

| arm         | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls | median failed calls | median result bytes | median wall time |
| ----------- | ---- | ------------ | ------ | ------------ | ---------- | ------------------ | ----------------- | ------------------- | ------------------- | ---------------- |
| claude-full | 11   | 1            | 0      | 0%           | 11         | 7 to 9.5           | 5.5               | 0                   | 63873               | 55.3 s           |

- claude-full pair 0: contaminated (runner: Error: tools/call: HTTP 503), mcp:217eb18c-f58a-4305-8401-6640b4c5dcd8
- claude-full pair 0: ok, turns 7 to 10, calls 6, 65713 B, 60.1 s, 3 follow-up runs, failed calls: mcp__goat__goat_provider_list invalid_request, mcp:72d9cb86-458d-41b8-8f53-6e36cb722c46
- claude-full pair 0: ok, turns 7 to 10, calls 6, 74342 B, 64.5 s, 3 follow-up runs, mcp:c05f59e1-9394-4178-a453-3aad166fd565
- claude-full pair 0: ok, turns 6 to 9, calls 5, 65543 B, 50.9 s, 3 follow-up runs, mcp:c573a8dc-1106-4f35-9913-be9931c8df73
- claude-full pair 0: ok, turns 7 to 9, calls 5, 62117 B, 55.0 s, 3 follow-up runs, mcp:6436caee-ac5d-45f0-9d83-3bcbfa2085da
- claude-full pair 0: ok, turns 7 to 11, calls 7, 76724 B, 53.9 s, 3 follow-up runs, failed calls: mcp__goat__goat_provider_list invalid_request, mcp:3aaa8dcb-f581-42f5-9deb-95f5e141419a
- claude-full pair 0: ok, turns 8 to 10, calls 6, 62239 B, 53.1 s, 3 follow-up runs, failed calls: mcp__goat__goat_provider_list invalid_request, mcp:263cdf7d-6e54-4d58-aa06-e73e205f3de0
- claude-full pair 0: ok, turns 6 to 9, calls 5, 65147 B, 55.9 s, 3 follow-up runs, mcp:5550c177-c51f-48d5-bdff-4e05041eb751
- claude-full pair 0: ok, turns 7 to 10, calls 6, 62599 B, 69.5 s, 3 follow-up runs, failed calls: mcp__goat__goat_provider_list invalid_request, mcp:62d2ee87-5481-407f-948d-50d8f030cdd0
- claude-full pair 0: ok, turns 6 to 9, calls 5, 62117 B, 47.5 s, 3 follow-up runs, mcp:648b767c-316f-4252-8956-e7b7f0a50d73
- claude-full pair 0: ok, turns 6 to 9, calls 5, 62069 B, 55.5 s, 3 follow-up runs, mcp:81f4ec99-f2e5-49c9-977f-1096e21bd555

## launch-and-wait (reduces): not_run

- the baseline has no clean runs

| arm         | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls | median failed calls | median result bytes | median wall time |
| ----------- | ---- | ------------ | ------ | ------------ | ---------- | ------------------ | ----------------- | ------------------- | ------------------- | ---------------- |
| claude-full | 0    | 0            | 0      | -            | 0          | - to -             | -                 | -                   | -                   | -                |
