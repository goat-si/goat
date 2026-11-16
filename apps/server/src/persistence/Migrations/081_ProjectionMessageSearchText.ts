import { CITATION_LINK_PROTOCOLS } from "@goat/contracts/legacyT3Names";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  readableSearchText,
  recreateMessageSearchTriggers,
} from "../../orchestration-v2/messageSearchIndex.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // GOAT ledgers run this late, during id reconciliation, so it may find its own column.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(orchestration_v2_projection_messages)
  `;
  if (!columns.some((column) => column.name === "search_text")) {
    yield* sql`ALTER TABLE orchestration_v2_projection_messages ADD COLUMN search_text TEXT`;
  }

  // Migration 74's triggers index the stored text, where a quote's words are
  // percent-encoded. Recreated now that search_text exists, they index it, and
  // the backfill below re-indexes every message that reads differently.
  yield* recreateMessageSearchTriggers(sql);

  // Only messages holding a citation link, GOAT's or the legacy one, read
  // differently. The raw check first skips parsing the JSON of every other message.
  const holdsCitation = sql.or(
    CITATION_LINK_PROTOCOLS.map((protocol) => sql`payload_json LIKE ${`%${protocol}://%`}`),
  );
  const pageSize = 500;
  let afterMessageId = "";
  while (true) {
    const rows = yield* sql<{ readonly message_id: string; readonly text: string }>`
      SELECT message_id, json_extract(payload_json, '$.text') AS text
      FROM orchestration_v2_projection_messages
      WHERE message_id > ${afterMessageId}
        AND ${holdsCitation}
        AND json_type(payload_json, '$.text') = 'text'
      ORDER BY message_id
      LIMIT ${pageSize}
    `;
    for (const row of rows) {
      const searchText = readableSearchText(row.text);
      if (searchText === null) continue;
      yield* sql`
        UPDATE orchestration_v2_projection_messages
        SET search_text = ${searchText}
        WHERE message_id = ${row.message_id}
      `;
    }
    const last = rows.at(-1);
    if (rows.length < pageSize || last === undefined) break;
    afterMessageId = last.message_id;
  }
});
