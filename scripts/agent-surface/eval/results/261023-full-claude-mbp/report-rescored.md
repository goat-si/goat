# Listing measurement

**Reference, not paired**: numbers, no verdict. One arm (claude-full). Task set 2; the current set is 3.

Campaign cmvl2mf4m.

Model turns are a range: tool rounds + 1 to tool calls + 1. Medians use successful clean runs; a verdict needs 10 of them per arm. Result bytes are the compact JSON the server returned to the run's tool calls.

## First prompt (context-budget.ts)

Commit bb7f97ae2: 202 tools, 278143 model-facing listing bytes.

| harness           | instructions | first prompt | every later turn |
| ----------------- | ------------ | ------------ | ---------------- |
| Codex (code mode) | 25226        | 303369       | 0                |
| Claude            | 22208        | 300351       | 0                |
| OpenCode          | 22224        | 300367       | 0                |
| Cursor            | 22328        | 300471       | 2150             |
| ACP               | 24519        | 302662       | 2040             |
| Pi                | 20072        | 298215       | 0                |

## read-control (no_gain): baseline_only

| arm         | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls | median failed calls | median result bytes | median wall time |
| ----------- | ---- | ------------ | ------ | ------------ | ---------- | ------------------ | ----------------- | ------------------- | ------------------- | ---------------- |
| claude-full | 10   | 0            | 0      | 0%           | 10         | 3 to 3.5           | 2.5               | 1                   | 5400                | 12.0 s           |

- claude-full pair 0: ok, turns 3 to 4, calls 3, 5520 B, 16.5 s, mcp:374dae85-d8d1-4eec-957b-58103f0d0188
- claude-full pair 1: ok, turns 3 to 4, calls 3, 4300 B, 12.2 s, mcp:5ca6c207-01df-4f3c-8a5c-e974f55f4581
- claude-full pair 2: ok, turns 2 to 3, calls 2, 5400 B, 9.5 s, mcp:f0166a48-504e-4456-8da7-c043300188af
- claude-full pair 3: ok, turns 3 to 4, calls 3, 5560 B, 15.6 s, mcp:9769a248-48f9-4f73-8994-f0362f1ce1ff
- claude-full pair 4: ok, turns 2 to 3, calls 2, 5400 B, 14.9 s, mcp:f89807a5-5fac-410d-a3ee-6a562921810b
- claude-full pair 5: ok, turns 3 to 3, calls 2, 5400 B, 9.7 s, mcp:2ded1258-f0e3-4f59-bcdb-cb2efded098f
- claude-full pair 6: ok, turns 2 to 4, calls 3, 4295 B, 11.8 s, mcp:09a98eb4-8ae2-4a02-bc78-aa9c8e732c89
- claude-full pair 7: ok, turns 3 to 4, calls 3, 4295 B, 11.3 s, mcp:f9d4d4ec-09cf-42cf-86ef-ae55a5bd8b05
- claude-full pair 8: ok, turns 2 to 3, calls 2, 5400 B, 9.9 s, mcp:ed93c075-9796-499a-a2a4-0ca3577eee62
- claude-full pair 9: ok, turns 3 to 3, calls 2, 5400 B, 12.4 s, mcp:614aa3fa-64e7-4b6e-9824-71f6fd9c572c

## wait-running (reduces): baseline_only

| arm         | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls | median failed calls | median result bytes | median wall time |
| ----------- | ---- | ------------ | ------ | ------------ | ---------- | ------------------ | ----------------- | ------------------- | ------------------- | ---------------- |
| claude-full | 10   | 0            | 0      | 0%           | 10         | 3 to 6             | 5                 | 0.5                 | 9029                | 25.5 s           |

- claude-full pair 0: ok, turns 3 to 5, calls 4, 25942 B, 26.1 s, mcp:416cda38-053f-4cf2-84c6-374ad92a98cf
- claude-full pair 1: ok, turns 3 to 6, calls 5, 8984 B, 21.5 s, mcp:7292ff12-1486-40c9-b266-d31e7f4a120b
- claude-full pair 2: ok, turns 3 to 6, calls 5, 8984 B, 19.7 s, mcp:a5cfbb8b-5cf1-49df-a621-11a2f5cf3a18
- claude-full pair 3: ok, turns 3 to 5, calls 4, 43288 B, 27.3 s, mcp:4be5638d-79c8-40fb-bfe8-08efc0567608
- claude-full pair 4: ok, turns 4 to 6, calls 5, 8991 B, 21.0 s, mcp:ac627a65-be49-4f66-acad-bbf0439a89cc
- claude-full pair 5: ok, turns 3 to 6, calls 5, 8984 B, 20.8 s, mcp:d5cb1edd-36a7-4418-b286-390c96df326b
- claude-full pair 6: ok, turns 3 to 6, calls 5, 8984 B, 26.5 s, mcp:7a983465-5b03-4cce-9e1a-bd941d91495f
- claude-full pair 7: ok, turns 4 to 6, calls 5, 9067 B, 25.6 s, mcp:73241c58-1b38-45d5-996e-a19505f6a459
- claude-full pair 8: ok, turns 3 to 5, calls 4, 72198 B, 32.0 s, mcp:a11332e5-835a-4fdf-8dcd-abe86423645a
- claude-full pair 9: ok, turns 3 to 5, calls 4, 76608 B, 25.4 s, mcp:4da5ccc4-5db7-49b9-9bca-63bdd83263dc

## fan-out-review (reduces): baseline_only

| arm         | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls | median failed calls | median result bytes | median wall time |
| ----------- | ---- | ------------ | ------ | ------------ | ---------- | ------------------ | ----------------- | ------------------- | ------------------- | ---------------- |
| claude-full | 2    | 0            | 0      | 0%           | 2          | 5.5 to 11.5        | 10.5              | 2                   | 38546               | 52.4 s           |

- claude-full pair 0: ok, turns 6 to 12, calls 11, 37559 B, 51.3 s, mcp:362df896-4bf1-45e3-8d02-77b56ab0960d
- claude-full pair 2: ok, turns 5 to 11, calls 10, 39533 B, 53.4 s, mcp:50973207-0e9d-4a62-b8f9-e5c4e68f53fc

## launch-and-wait (reduces): not_run

- the baseline has no clean runs

| arm         | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls | median failed calls | median result bytes | median wall time |
| ----------- | ---- | ------------ | ------ | ------------ | ---------- | ------------------ | ----------------- | ------------------- | ------------------- | ---------------- |
| claude-full | 0    | 0            | 0      | -            | 0          | - to -             | -                 | -                   | -                   | -                |
