# Listing measurement

Verdict: **not met** (read-control: fail; wait-running: fail; fan-out-review: fail; launch-and-wait: fail)

Campaign cmvl7drv2.

Model turns are a range: tool rounds + 1 to tool calls + 1. Medians use successful clean runs; a verdict needs 10 of them per arm. The control may rise by at most 1 turn at either end of the range; a multi-step task may not rise at either end; neither may fail more often. Result bytes are the compact JSON the server returned to the run's tool calls.

## First prompt (context-budget.ts)

Commit d03528657: 202 tools, 212421 model-facing listing bytes.

| harness           | instructions | first prompt | every later turn |
| ----------------- | ------------ | ------------ | ---------------- |
| Codex (code mode) | 25226        | 237647       | 0                |
| Claude            | 22208        | 234629       | 0                |
| OpenCode          | 22224        | 234645       | 0                |
| Cursor            | 22328        | 234749       | 2150             |
| ACP               | 24519        | 236940       | 2040             |
| Pi                | 20072        | 232493       | 0                |

## read-control (no_gain): fail

- the candidate's median turns rose by more than 1

| arm  | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls | median failed calls | median result bytes | median wall time |
| ---- | ---- | ------------ | ------ | ------------ | ---------- | ------------------ | ----------------- | ------------------- | ------------------- | ---------------- |
| full | 10   | 0            | 0      | 0%           | 5          | 2 to 2             | 1                 | 0                   | 2447                | 7.8 s            |
| core | 10   | 0            | 0      | 0%           | 5          | 2 to 5             | 4                 | 2                   | 7466                | 15.2 s           |

- full pair 0: ok, turns 2 to 2, calls 1, 2447 B, 11.5 s, mcp:f5921c32-1e18-49e0-90e5-2be2abcb34f1
- core pair 0: ok, turns 2 to 5, calls 4, 6512 B, 27.1 s, failed calls: goat.goat_describe invalid_request, goat.goat_call invalid_request, mcp:15f40b43-bf13-4e03-a2bc-35bf2dd1b3c6
- core pair 1: ok, turns 2 to 5, calls 4, 19323 B, 13.6 s, failed calls: goat.goat_describe invalid_request, mcp:46e71f2a-1a97-4f59-bfe7-09ce1d1bcf8e
- full pair 1: ok, turns 2 to 2, calls 1, 2447 B, 7.1 s, mcp:ada92b54-6214-4fc7-97b9-c8a617469ab2
- full pair 2: ok, turns 2 to 2, calls 1, 2447 B, 8.6 s, mcp:f7a1808d-3660-43e6-85d0-24dfe949a56e
- core pair 2: ok, turns 2 to 5, calls 4, 6506 B, 13.5 s, failed calls: goat.goat_describe invalid_request, goat.goat_call invalid_request, mcp:a6ae07ba-10b5-4ae9-8c11-5875539c8c7e
- core pair 3: ok, turns 2 to 5, calls 4, 8420 B, 21.3 s, failed calls: goat.goat_describe invalid_request, goat.goat_call invalid_request, mcp:c0da5a99-b2b9-4603-bb16-e03cb519568f
- full pair 3: ok, turns 2 to 2, calls 1, 2447 B, 7.9 s, mcp:26da6b25-8c85-4631-a3df-eb2fb337cbea
- full pair 4: ok, turns 2 to 2, calls 1, 2447 B, 6.2 s, mcp:4ce5d7cd-7e05-4396-bc08-2adca1afee37
- core pair 4: ok, turns 2 to 3, calls 2, 2658 B, 10.1 s, failed calls: goat.goat_call invalid_request, mcp:ef03ee78-d8a3-43c3-9b9f-9a5f92704be0
- core pair 5: ok, turns 2 to 2, calls 1, 2471 B, 12.1 s, mcp:461c17ee-1674-4d45-b466-9d8056bda6b2
- full pair 5: ok, turns 2 to 2, calls 1, 2447 B, 5.7 s, mcp:13215462-fccf-470c-8acc-c69d5d47f167
- full pair 6: ok, turns 2 to 2, calls 1, 2447 B, 6.1 s, mcp:43cb13a8-d1b9-47a1-aa09-df82c8501306
- core pair 6: ok, turns 2 to 7, calls 6, 21387 B, 34.8 s, failed calls: goat.goat_describe invalid_request, goat.goat_call invalid_request, mcp:f0f4b675-edac-4283-88a8-9dcf77b3ea59
- core pair 7: ok, turns 2 to 6, calls 5, 19506 B, 16.9 s, failed calls: goat.goat_describe invalid_request, goat.goat_call invalid_request, mcp:3718bbe6-129b-408c-b563-c3044d760826
- full pair 7: ok, turns 2 to 2, calls 1, 2447 B, 7.6 s, mcp:a84635af-948e-491f-9cb4-19a6e9a8ef53
- full pair 8: ok, turns 2 to 2, calls 1, 2447 B, 9.2 s, mcp:78e8bf26-5c00-4403-9761-909dec1043a5
- core pair 8: ok, turns 2 to 6, calls 5, 19500 B, 18.4 s, failed calls: goat.goat_describe invalid_request, goat.goat_call invalid_request, mcp:28331364-38ff-4be0-8d7b-d486fc7089dd
- core pair 9: ok, turns 2 to 3, calls 2, 2658 B, 12.7 s, failed calls: goat.goat_call invalid_request, mcp:836e6c96-3166-478a-97e8-7a7ed47dd8b3
- full pair 9: ok, turns 2 to 2, calls 1, 2447 B, 8.6 s, mcp:3d59000f-164d-42d9-b5e5-46bd6b5e5f4d

## wait-running (reduces): fail

- the candidate's median turns rose

| arm  | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls | median failed calls | median result bytes | median wall time |
| ---- | ---- | ------------ | ------ | ------------ | ---------- | ------------------ | ----------------- | ------------------- | ------------------- | ---------------- |
| full | 10   | 0            | 0      | 0%           | 5          | 2 to 6             | 5                 | 1                   | 5053                | 18.5 s           |
| core | 10   | 0            | 0      | 0%           | 5          | 2 to 8             | 7                 | 1                   | 16468.5             | 29.6 s           |

- full pair 0: ok, turns 2 to 6, calls 5, 4304 B, 17.4 s, failed calls: goat.goat_thread_list invalid_request, mcp:c1416a8c-32c2-41a7-92de-bc89a93ccf56
- core pair 0: ok, turns 2 to 8, calls 7, 10803 B, 20.7 s, failed calls: goat.goat_describe invalid_request, mcp:78fedfd0-5195-4a35-a765-d816390e1290
- core pair 1: ok, turns 2 to 11, calls 10, 22481 B, 30.0 s, failed calls: goat.goat_describe invalid_request, goat.goat_describe invalid_request, goat.goat_call invalid_request, mcp:6841e871-0ded-46d2-b1e3-a08afb165191
- full pair 1: ok, turns 2 to 6, calls 5, 3620 B, 16.5 s, failed calls: goat.goat_thread_list invalid_request, mcp:e9f0e277-2c02-4389-b0a0-eac7902acab4
- full pair 2: ok, turns 2 to 6, calls 5, 4304 B, 14.2 s, failed calls: goat.goat_thread_list invalid_request, mcp:c7cb9fd8-87dc-439d-bfca-d9708d0db483
- core pair 2: ok, turns 2 to 9, calls 8, 25527 B, 20.8 s, mcp:fb88d218-1567-4fdf-b5e1-07a8eabbb4b4
- core pair 3: ok, turns 2 to 8, calls 7, 14750 B, 30.8 s, failed calls: goat.goat_describe invalid_request, mcp:fbee1e80-7e53-4a98-8070-40ce08879f71
- full pair 3: ok, turns 2 to 6, calls 5, 3620 B, 17.5 s, failed calls: goat.goat_thread_list invalid_request, mcp:bfbc328d-b61d-42a7-a30f-3ffcfe69638a
- full pair 4: ok, turns 2 to 6, calls 5, 69757 B, 14.8 s, mcp:f475e2f0-fc2a-4dd6-a1cb-6e2c6864637c
- core pair 4: ok, turns 2 to 10, calls 9, 26388 B, 25.5 s, failed calls: goat.goat_call invalid_request, mcp:3591b4cb-a084-4806-bf21-7c6be00e5b9d
- core pair 5: ok, turns 2 to 8, calls 7, 10803 B, 30.8 s, failed calls: goat.goat_describe invalid_request, mcp:57856fc2-a524-4a97-b7f3-593fefe2a8a2
- full pair 5: ok, turns 2 to 7, calls 6, 6486 B, 23.0 s, failed calls: goat.goat_thread_list invalid_request, mcp:ff2cd41f-e275-460d-9be2-e77099edafad
- full pair 6: ok, turns 2 to 7, calls 6, 5802 B, 19.5 s, failed calls: goat.goat_thread_list invalid_request, mcp:96a79d5a-9156-48ad-a6f8-aff117572d21
- core pair 6: ok, turns 2 to 13, calls 12, 27614 B, 27.4 s, mcp:76b39c26-528a-4f70-b74c-b374d62ad7a7
- core pair 7: ok, turns 2 to 8, calls 7, 10803 B, 29.3 s, failed calls: goat.goat_describe invalid_request, mcp:6bd60b77-2e52-4510-8db2-adb2812e8210
- full pair 7: ok, turns 3 to 6, calls 5, 4304 B, 21.4 s, failed calls: goat.goat_thread_list invalid_request, mcp:4e6ca267-d1fa-4667-b392-a86a84d3fa9f
- full pair 8: ok, turns 3 to 7, calls 6, 6486 B, 22.8 s, failed calls: goat.goat_thread_list invalid_request, mcp:3708acfc-5899-405c-bd68-b744ee5d107f
- core pair 8: ok, turns 2 to 8, calls 7, 12827 B, 32.6 s, failed calls: goat.goat_describe invalid_request, mcp:69045d93-9e02-4616-ae35-334f890f571d
- core pair 9: ok, turns 2 to 8, calls 7, 18187 B, 33.7 s, mcp:cfa9dbf2-c1fd-4fe8-96bb-b891f4d98101
- full pair 9: ok, turns 2 to 7, calls 6, 5802 B, 24.1 s, failed calls: goat.goat_thread_list invalid_request, mcp:b5fc2727-2a15-4464-8a4b-f367fa336619

## fan-out-review (reduces): fail

- fewer than 10 successful clean runs in an arm

| arm  | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls | median failed calls | median result bytes | median wall time |
| ---- | ---- | ------------ | ------ | ------------ | ---------- | ------------------ | ----------------- | ------------------- | ------------------- | ---------------- |
| full | 10   | 0            | 1      | 10%          | 5          | 3 to 14            | 13                | 0                   | 24751               | 35.5 s           |
| core | 10   | 2            | 0      | 0%           | 5          | 3 to 13            | 12                | 1                   | 35386               | 41.6 s           |

- full pair 0: ok, turns 4 to 19, calls 18, 34087 B, 41.9 s, mcp:34af7a42-dfa5-453b-91b4-fe2043d011ac
- core pair 0: ok, turns 3 to 12, calls 11, 29665 B, 37.3 s, failed calls: goat.goat_describe invalid_request, mcp:b49dfb27-0689-42f2-ae33-231e3b84ffbf
- core pair 1: contaminated (command_execution is not available to arm core; file_change is not available to arm core), turns 5 to 11, calls 10, 16016 B, 63.8 s, mcp:420fad39-800f-4806-8e1f-5569f3935945
- full pair 1: ok, turns 3 to 7, calls 6, 6782 B, 36.2 s, mcp:fb16d9dc-704f-46c3-82d9-7fd9d5063cac
- full pair 2: ok, turns 3 to 19, calls 18, 27321 B, 27.0 s, mcp:7174e625-4e99-41de-bf1a-cd66e0502596
- core pair 2: ok, turns 3 to 17, calls 16, 41901 B, 40.9 s, failed calls: goat.goat_describe invalid_request, mcp:4f01f92d-d5b9-4d8f-8abf-940a5371cc95
- core pair 3: ok, turns 2 to 6, calls 5, 25802 B, 63.9 s, failed calls: goat.goat_describe invalid_request, mcp:982e6eff-9c0f-453f-8048-d0f6a1cec988
- full pair 3: failed (4 delegated tasks started, 3 requested), turns 7 to 46, calls 45, 95080 B, 119.0 s, mcp:894da784-a6e1-4fe3-8586-ec3b3b46ee4b
- full pair 4: ok, turns 4 to 15, calls 14, 31920 B, 38.3 s, mcp:c4c9e375-b384-4dbf-8588-72606400d2eb
- core pair 4: ok, turns 3 to 15, calls 14, 36344 B, 42.3 s, failed calls: goat.goat_describe invalid_request, mcp:4beef785-7bd2-4dd8-b68f-ea17aa33f393
- core pair 5: contaminated (command_execution is not available to arm core), turns 4 to 9, calls 8, 37933 B, 46.3 s, failed calls: goat.goat_describe invalid_request, mcp:f3e5f805-22c9-4539-a641-a503024d4ab4
- full pair 5: ok, turns 3 to 14, calls 13, 24816 B, 35.5 s, mcp:e7cdbfe2-553b-427e-a97a-d89597daf3b4
- full pair 6: ok, turns 3 to 11, calls 10, 15550 B, 34.1 s, mcp:c54f89e4-0eb4-4cf4-b133-963b8f65fceb
- core pair 6: ok, turns 3 to 12, calls 11, 34428 B, 38.5 s, failed calls: goat.goat_describe invalid_request, mcp:0ce5ac03-8580-4211-a40c-90c43cf5705e
- core pair 7: ok, turns 3 to 18, calls 17, 39100 B, 36.4 s, failed calls: goat.goat_describe invalid_request, mcp:679c58bc-6435-4f09-9565-efb3553b03bd
- full pair 7: ok, turns 2 to 4, calls 3, 3627 B, 36.0 s, mcp:892d62c7-b672-48c2-9a7e-92050e832af6
- full pair 8: ok, turns 3 to 19, calls 18, 24751 B, 33.7 s, mcp:5fdc24a7-3750-4504-856f-7c6aab43da40
- core pair 8: ok, turns 4 to 14, calls 13, 71637 B, 50.0 s, failed calls: goat.goat_describe invalid_request, goat.goat_describe invalid_request, mcp:f6c62f41-75b0-4752-b79c-eacc0484828a
- core pair 9: ok, turns 2 to 6, calls 5, 28693 B, 52.3 s, mcp:d2ad91b4-2e0b-4512-9a10-689bc05def6f
- full pair 9: ok, turns 2 to 4, calls 3, 3391 B, 28.9 s, mcp:abef3b7a-9b2a-4247-99e6-67e24b3b1df0

## launch-and-wait (reduces): fail

- the candidate's median turns rose

| arm  | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls | median failed calls | median result bytes | median wall time |
| ---- | ---- | ------------ | ------ | ------------ | ---------- | ------------------ | ----------------- | ------------------- | ------------------- | ---------------- |
| full | 10   | 0            | 0      | 0%           | 5          | 3 to 5             | 4                 | 2                   | 1404.5              | 19.2 s           |
| core | 10   | 0            | 0      | 0%           | 5          | 3 to 6.5           | 5.5               | 1                   | 20582               | 27.3 s           |

- full pair 0: ok, turns 3 to 5, calls 4, 1395 B, 18.9 s, failed calls: goat.goat_thread_launch invalid_request, goat.goat_thread_launch ?, mcp:bc0a0ff7-041b-4fdc-bf49-2ca624dbbfdc
- core pair 0: ok, turns 3 to 7, calls 6, 35195 B, 29.1 s, failed calls: goat.goat_describe invalid_request, mcp:ca43526b-95f9-4dc9-bc84-e4c949ddae97
- core pair 1: ok, turns 3 to 5, calls 4, 15667 B, 27.4 s, failed calls: goat.goat_describe invalid_request, mcp:c3decfdd-dfeb-4f3a-988e-8d623a6fb415
- full pair 1: ok, turns 2 to 3, calls 2, 700 B, 13.3 s, mcp:68a7fbe3-0d60-42df-8547-2aaea16f5c74
- full pair 2: ok, turns 3 to 5, calls 4, 1414 B, 19.9 s, failed calls: goat.goat_thread_launch invalid_request, goat.goat_thread_launch ?, mcp:bdda47ec-8aec-4b41-a2f6-e675e4b0a122
- core pair 2: ok, turns 3 to 8, calls 7, 35399 B, 29.8 s, failed calls: goat.goat_describe invalid_request, goat.goat_describe invalid_request, mcp:0966a7ab-f0eb-4ee3-b763-dbc71858254f
- core pair 3: ok, turns 3 to 7, calls 6, 35195 B, 21.6 s, failed calls: goat.goat_describe invalid_request, mcp:caac674e-7cf3-40aa-868e-7d083c763c2e
- full pair 3: ok, turns 3 to 3, calls 2, 700 B, 16.1 s, mcp:6c0c2d20-4f3d-4170-9bc7-ee6ac558cec7
- full pair 4: ok, turns 3 to 5, calls 4, 1395 B, 17.4 s, failed calls: goat.goat_thread_launch invalid_request, goat.goat_thread_launch ?, mcp:3800404f-81f4-41be-abfa-8b8bcc17d001
- core pair 4: ok, turns 2 to 6, calls 5, 20480 B, 20.9 s, failed calls: goat.goat_describe invalid_request, mcp:7b01592a-a1ed-40c8-ad6c-2d6091149132
- core pair 5: ok, turns 3 to 7, calls 6, 35195 B, 32.2 s, failed calls: goat.goat_describe invalid_request, mcp:dadd4af4-141e-4a5c-8b92-04692f19dead
- full pair 5: ok, turns 3 to 5, calls 4, 1414 B, 20.9 s, failed calls: goat.goat_thread_launch invalid_request, goat.goat_thread_launch ?, mcp:2e12bc31-36a1-41df-b709-cb80d7e3df15
- full pair 6: ok, turns 3 to 5, calls 4, 1414 B, 26.6 s, failed calls: goat.goat_thread_launch invalid_request, goat.goat_thread_launch ?, mcp:0a0cb13f-2d87-4e32-b293-842519dedc73
- core pair 6: ok, turns 3 to 5, calls 4, 15667 B, 27.3 s, failed calls: goat.goat_describe invalid_request, mcp:af95811c-d258-4d0f-b2be-f031c40301d1
- core pair 7: ok, turns 2 to 7, calls 6, 20684 B, 18.2 s, failed calls: goat.goat_describe invalid_request, goat.goat_describe invalid_request, mcp:6e9a15a9-04ed-4169-a440-106f59873817
- full pair 7: ok, turns 2 to 3, calls 2, 700 B, 19.5 s, mcp:2abce359-179a-468a-a586-5b6d59db8281
- full pair 8: ok, turns 3 to 5, calls 4, 1414 B, 17.9 s, failed calls: goat.goat_thread_launch invalid_request, goat.goat_thread_launch ?, mcp:ac1151fa-3ddb-4b4c-8110-34b100a35300
- core pair 8: ok, turns 3 to 6, calls 5, 20480 B, 28.6 s, failed calls: goat.goat_describe invalid_request, mcp:e2e5fd0c-f7ae-490c-b8af-32f9364a0986
- core pair 9: ok, turns 2 to 6, calls 5, 20480 B, 19.7 s, failed calls: goat.goat_describe invalid_request, mcp:f0c4251a-19e2-44fd-8534-a37f6475558f
- full pair 9: ok, turns 3 to 5, calls 4, 1414 B, 22.2 s, failed calls: goat.goat_thread_launch invalid_request, goat.goat_thread_launch ?, mcp:e0d0f77d-266e-45c3-84d3-f6663ac06690
