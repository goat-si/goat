# Listing measurement

Baseline only (arm codex-full): numbers, no verdict.

Model turns are a range: tool rounds + 1 to tool calls + 1. Medians use successful clean runs; a verdict needs 10 of them per arm. Result bytes are the compact JSON the server returned to the run's tool calls.

## First prompt (context-budget.ts)

Commit 368b2c84a (dirty tree): 202 tools, 278143 model-facing listing bytes.

| harness           | instructions | first prompt | every later turn |
| ----------------- | ------------ | ------------ | ---------------- |
| Codex (code mode) | 25226        | 303369       | 0                |
| Claude            | 22208        | 300351       | 0                |
| OpenCode          | 22224        | 300367       | 0                |
| Cursor            | 22328        | 300471       | 2150             |
| ACP               | 24519        | 302662       | 2040             |
| Pi                | 20072        | 298215       | 0                |

## read-control (no_gain): baseline_only

| arm        | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls | median failed calls | median result bytes | median wall time |
| ---------- | ---- | ------------ | ------ | ------------ | ---------- | ------------------ | ----------------- | ------------------- | ------------------- | ---------------- |
| codex-full | 12   | 0            | 0      | 0%           | 12         | 2 to 2             | 1                 | 0                   | 2447                | 6.6 s            |

- codex-full pair 0: ok, turns 2 to 2, calls 1, 2447 B, 6.8 s, mcp:443d3c8e-cdd7-4ca5-9c36-60ee01dd1922
- codex-full pair 1: ok, turns 2 to 2, calls 1, 583 B, 9.9 s, mcp:e42a8f44-9df0-42eb-94e0-c45fa5f759cb
- codex-full pair 2: ok, turns 2 to 2, calls 1, 2447 B, 6.2 s, mcp:cf000aa5-18a4-4d42-8750-d09ea21aae04
- codex-full pair 3: ok, turns 2 to 2, calls 1, 2447 B, 6.3 s, mcp:17e7ddba-9c91-4a21-a9c3-9f55dc2d15b1
- codex-full pair 4: ok, turns 2 to 2, calls 1, 2447 B, 8.9 s, mcp:faef6e15-b8e1-4455-b9c6-6fdaa932c5f2
- codex-full pair 5: ok, turns 2 to 2, calls 1, 2447 B, 6.5 s, mcp:c0261c9f-d116-468f-84d7-801c7312db4e
- codex-full pair 6: ok, turns 2 to 2, calls 1, 2447 B, 6.5 s, mcp:92098cd9-74a4-445d-9beb-b033a7de747d
- codex-full pair 7: ok, turns 2 to 2, calls 1, 2447 B, 6.9 s, mcp:e014a1ea-454a-4dd4-89a8-53be4b082d27
- codex-full pair 8: ok, turns 2 to 2, calls 1, 2447 B, 7.9 s, mcp:75e0416c-1096-454c-9248-18ecbeb50511
- codex-full pair 9: ok, turns 2 to 2, calls 1, 2447 B, 5.5 s, mcp:6f0baeb7-417f-4ea7-996b-cf35c0c51fb0
- codex-full pair 10: ok, turns 2 to 2, calls 1, 2447 B, 6.1 s, mcp:2f56aaec-ad4f-4fd7-a27b-c2d89b47a690
- codex-full pair 11: ok, turns 2 to 2, calls 1, 2447 B, 7.1 s, mcp:c43305b5-ac06-41bf-b342-cd6efa56861b

## wait-running (reduces): baseline_only

| arm        | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls | median failed calls | median result bytes | median wall time |
| ---------- | ---- | ------------ | ------ | ------------ | ---------- | ------------------ | ----------------- | ------------------- | ------------------- | ---------------- |
| codex-full | 12   | 0            | 0      | 0%           | 12         | 2 to 6             | 5                 | 1                   | 4340                | 22.9 s           |

- codex-full pair 0: ok, turns 2 to 5, calls 4, 4051 B, 24.7 s, mcp:f2e3c092-708b-43fe-b476-19413a6c7172
- codex-full pair 1: ok, turns 2 to 6, calls 5, 3638 B, 15.8 s, mcp:01005c2f-1d05-46ec-975d-23aedd0a09f1
- codex-full pair 2: ok, turns 2 to 5, calls 4, 30636 B, 14.6 s, mcp:b92376aa-d516-43d9-a17b-98700e2d854e
- codex-full pair 3: ok, turns 2 to 6, calls 5, 3638 B, 22.9 s, mcp:f1736001-f280-49a4-8f16-e409dd446152
- codex-full pair 4: ok, turns 2 to 7, calls 6, 14544 B, 39.6 s, mcp:77cde6e6-d720-4cbe-80b2-aa58e3fa1e9b
- codex-full pair 5: ok, turns 3 to 7, calls 6, 6540 B, 39.5 s, mcp:474da563-4bb0-4ccf-b6df-ea21341ecab6
- codex-full pair 6: ok, turns 2 to 6, calls 5, 4340 B, 23.0 s, mcp:7d414f32-7f3c-4ef2-90c0-05a9e32c483e
- codex-full pair 7: ok, turns 2 to 6, calls 5, 4340 B, 15.1 s, mcp:c25bb2ba-386a-46e2-80c8-0ea9f6f9039b
- codex-full pair 8: ok, turns 2 to 6, calls 5, 4340 B, 21.5 s, mcp:efb1af71-c6d9-4b21-a989-2e87ebd69d08
- codex-full pair 9: ok, turns 3 to 6, calls 5, 4340 B, 21.9 s, mcp:b85b2554-e45e-4692-ad85-2adeb8b3253f
- codex-full pair 10: ok, turns 2 to 6, calls 5, 4215 B, 26.3 s, mcp:79655de3-d883-4f9b-ba16-9d832c88bd35
- codex-full pair 11: ok, turns 2 to 5, calls 4, 3352 B, 30.5 s, mcp:5da69fec-aa1d-45af-a1dd-d2d1b579c005

## fan-out-review (reduces): baseline_only

| arm        | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls | median failed calls | median result bytes | median wall time |
| ---------- | ---- | ------------ | ------ | ------------ | ---------- | ------------------ | ----------------- | ------------------- | ------------------- | ---------------- |
| codex-full | 12   | 0            | 0      | 0%           | 12         | 3 to 17            | 16                | 0                   | 32198               | 41.7 s           |

- codex-full pair 0: ok, turns 4 to 16, calls 15, 32088 B, 38.1 s, mcp:62405729-622b-44d6-9594-bb5743b21c01
- codex-full pair 1: ok, turns 2 to 20, calls 19, 36317 B, 41.9 s, mcp:983bd78d-ee89-4c45-acb0-e0d067f3bc7c
- codex-full pair 2: ok, turns 3 to 16, calls 15, 32308 B, 41.5 s, mcp:e7376acc-a113-418d-abe5-fd9725a62142
- codex-full pair 3: ok, turns 5 to 19, calls 18, 36180 B, 56.3 s, mcp:2fcfef90-ab82-486f-a781-8f9a8853b032
- codex-full pair 4: ok, turns 3 to 17, calls 16, 35605 B, 40.5 s, mcp:84eb9df9-e763-4358-9512-ee45e0d48841
- codex-full pair 5: ok, turns 4 to 19, calls 18, 42301 B, 39.9 s, mcp:ab938db3-46dc-4224-928d-7bc287e6279f
- codex-full pair 6: ok, turns 4 to 12, calls 11, 16877 B, 42.5 s, mcp:c8f5d4a9-8d7a-42b0-a8d6-1254cd0b45c8
- codex-full pair 7: ok, turns 3 to 17, calls 16, 28264 B, 42.6 s, mcp:e3c13a68-92f0-4133-b8b1-9acb0ceaa076
- codex-full pair 8: ok, turns 4 to 19, calls 18, 37153 B, 42.2 s, mcp:4d260236-b4bd-4bac-b7a5-78aa3bb2f75b
- codex-full pair 9: ok, turns 3 to 17, calls 16, 26825 B, 31.0 s, mcp:c26d629a-8025-463c-b3aa-51697c145b9e
- codex-full pair 10: ok, turns 3 to 17, calls 16, 28179 B, 44.0 s, mcp:9f327d8d-e8bc-499f-9175-288bc37bce45
- codex-full pair 11: ok, turns 3 to 5, calls 4, 4350 B, 31.4 s, mcp:25b0bbaf-1afc-4455-8900-0c21a87af5f4

## launch-and-wait (reduces): baseline_only

| arm        | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls | median failed calls | median result bytes | median wall time |
| ---------- | ---- | ------------ | ------ | ------------ | ---------- | ------------------ | ----------------- | ------------------- | ------------------- | ---------------- |
| codex-full | 12   | 0            | 0      | 0%           | 12         | 3 to 4             | 3                 | 1                   | 926                 | 16.2 s           |

- codex-full pair 0: ok, turns 2 to 3, calls 2, 700 B, 16.3 s, mcp:c4f7daeb-cdf0-4581-8e2e-8f4568a1a826
- codex-full pair 1: ok, turns 3 to 3, calls 2, 700 B, 16.7 s, mcp:8701cfbf-b7fe-424c-a62a-cac0ec71acd0
- codex-full pair 2: ok, turns 3 to 5, calls 4, 1397 B, 16.9 s, mcp:c17cd0b1-7661-4638-879e-fe5d84d9c8a0
- codex-full pair 3: ok, turns 3 to 4, calls 3, 926 B, 15.8 s, mcp:c6c788c0-af35-4f18-9d48-dc6aae8baa51
- codex-full pair 4: ok, turns 2 to 4, calls 3, 926 B, 13.5 s, mcp:7c8e429b-159d-4fbe-914e-b18c795a3ec9
- codex-full pair 5: ok, turns 2 to 4, calls 3, 926 B, 17.1 s, mcp:5201577c-3f2f-4c80-9013-4642661f9e69
- codex-full pair 6: ok, turns 3 to 4, calls 3, 926 B, 15.9 s, mcp:b3366053-ecdc-457e-a208-a2585587dd06
- codex-full pair 7: ok, turns 3 to 5, calls 4, 1397 B, 16.0 s, mcp:600fed2c-2d1e-427a-b716-59aa4a4f850e
- codex-full pair 8: ok, turns 3 to 4, calls 3, 926 B, 15.6 s, mcp:06d2e721-ead5-419f-bbdc-c9633a04baf7
- codex-full pair 9: ok, turns 2 to 3, calls 2, 700 B, 17.9 s, mcp:1d731c65-7629-4052-8ac3-c28b529dfec5
- codex-full pair 10: ok, turns 3 to 4, calls 3, 926 B, 21.7 s, mcp:cb4f5167-39c3-4468-b547-a69d2767470d
- codex-full pair 11: ok, turns 2 to 5, calls 4, 1397 B, 15.8 s, mcp:374fcfb9-a29b-430c-9a27-dad620409586
