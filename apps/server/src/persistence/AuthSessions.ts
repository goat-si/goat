import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  AuthClientMetadataDeviceType,
  AuthEnvironmentScopes,
  AuthSessionId,
  ClientSurface,
  ServerAuthSessionMethod,
  SessionPrincipalKind,
} from "@goat/contracts";

import {
  type AuthSessionRepositoryError,
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
} from "./Errors.ts";

export const AuthSessionClientMetadataRecord = Schema.Struct({
  label: Schema.NullOr(Schema.String),
  ipAddress: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.NullOr(Schema.String),
  browser: Schema.NullOr(Schema.String),
});
export type AuthSessionClientMetadataRecord = typeof AuthSessionClientMetadataRecord.Type;

/** The Pen member a session was issued to; immutable after issue (mesh link design §6). */
export const AuthSessionPenBinding = Schema.Struct({
  meshId: Schema.String,
  nodeId: Schema.String,
  signPub: Schema.String,
  noisePub: Schema.String,
});
export type AuthSessionPenBinding = typeof AuthSessionPenBinding.Type;

export const AuthSessionRecord = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  connectAccessGeneration: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  scopes: AuthEnvironmentScopes,
  method: ServerAuthSessionMethod,
  client: AuthSessionClientMetadataRecord,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  principalKind: SessionPrincipalKind,
  penBinding: Schema.NullOr(AuthSessionPenBinding),
  penMemberNode: Schema.NullOr(Schema.String),
});
export type AuthSessionRecord = typeof AuthSessionRecord.Type;

export const CreateAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  connectAccessGeneration: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  scopes: AuthEnvironmentScopes,
  method: ServerAuthSessionMethod,
  client: AuthSessionClientMetadataRecord,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  principalKind: SessionPrincipalKind,
  penBinding: Schema.optionalKey(Schema.NullOr(AuthSessionPenBinding)),
  penMemberNode: Schema.optionalKey(Schema.String),
});
export type CreateAuthSessionInput = typeof CreateAuthSessionInput.Type;

export const CreateReplacingActiveAuthSessionInput = Schema.Struct({
  session: CreateAuthSessionInput,
  revokedAt: Schema.DateTimeUtcFromString,
  replaceSessionId: Schema.optionalKey(AuthSessionId),
});
export type CreateReplacingActiveAuthSessionInput =
  typeof CreateReplacingActiveAuthSessionInput.Type;

export const GetAuthSessionByIdInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type GetAuthSessionByIdInput = typeof GetAuthSessionByIdInput.Type;

export const ListActiveAuthSessionsInput = Schema.Struct({
  now: Schema.DateTimeUtcFromString,
  connectedSessionIds: Schema.optionalKey(Schema.Array(AuthSessionId)),
});
export type ListActiveAuthSessionsInput = typeof ListActiveAuthSessionsInput.Type;

export const RevokeAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeAuthSessionInput = typeof RevokeAuthSessionInput.Type;

export const RevokeOtherAuthSessionsInput = Schema.Struct({
  currentSessionId: AuthSessionId,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeOtherAuthSessionsInput = typeof RevokeOtherAuthSessionsInput.Type;

export const SetAuthSessionLastConnectedAtInput = Schema.Struct({
  sessionId: AuthSessionId,
  lastConnectedAt: Schema.DateTimeUtcFromString,
});
export type SetAuthSessionLastConnectedAtInput = typeof SetAuthSessionLastConnectedAtInput.Type;

export const SetAuthSessionClientConnectionInput = Schema.Struct({
  sessionId: AuthSessionId,
  surface: Schema.NullOr(ClientSurface),
  appVersion: Schema.NullOr(Schema.String),
});
export type SetAuthSessionClientConnectionInput = typeof SetAuthSessionClientConnectionInput.Type;

export const PenBoundSessionsInput = Schema.Struct({
  now: Schema.DateTimeUtcFromString,
  nodeId: Schema.optionalKey(Schema.String),
});
export type PenBoundSessionsInput = typeof PenBoundSessionsInput.Type;

export const PenBoundSession = Schema.Struct({
  sessionId: AuthSessionId,
  nodeId: Schema.String,
  signPub: Schema.String,
  noisePub: Schema.String,
});
export type PenBoundSession = typeof PenBoundSession.Type;

export class AuthSessionRepository extends Context.Service<
  AuthSessionRepository,
  {
    readonly create: (
      input: CreateAuthSessionInput,
    ) => Effect.Effect<void, AuthSessionRepositoryError>;
    readonly createReplacingActive: (
      input: CreateReplacingActiveAuthSessionInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
    readonly createIfAbsent: (
      input: CreateAuthSessionInput,
    ) => Effect.Effect<void, AuthSessionRepositoryError>;
    readonly getById: (
      input: GetAuthSessionByIdInput,
    ) => Effect.Effect<Option.Option<AuthSessionRecord>, AuthSessionRepositoryError>;
    readonly listActive: (
      input: ListActiveAuthSessionsInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionRecord>, AuthSessionRepositoryError>;
    readonly revoke: (
      input: RevokeAuthSessionInput,
    ) => Effect.Effect<boolean, AuthSessionRepositoryError>;
    readonly revokeAllExcept: (
      input: RevokeOtherAuthSessionsInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
    readonly setLastConnectedAt: (
      input: SetAuthSessionLastConnectedAtInput,
    ) => Effect.Effect<void, AuthSessionRepositoryError>;
    readonly setClientConnection: (
      input: SetAuthSessionClientConnectionInput,
    ) => Effect.Effect<void, AuthSessionRepositoryError>;
    /** Unrevoked Pen-bound sessions with their member, of one member when nodeId is set. */
    readonly listPenBound: (
      input: PenBoundSessionsInput,
    ) => Effect.Effect<ReadonlyArray<PenBoundSession>, AuthSessionRepositoryError>;
    /** Active (unrevoked, unexpired) Pen-bound sessions: of nodeId and in total. */
    readonly countActivePenBound: (input: {
      readonly now: DateTime.Utc;
      readonly nodeId: string;
    }) => Effect.Effect<
      { readonly member: number; readonly total: number },
      AuthSessionRepositoryError
    >;
    /** Deletes Pen-bound rows that are revoked or expired; never touches any other row. */
    readonly deleteInactivePenBound: (
      input: PenBoundSessionsInput,
    ) => Effect.Effect<number, AuthSessionRepositoryError>;
  }
>()("goat/persistence/AuthSessions/AuthSessionRepository") {}

const AuthSessionDbRow = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  connectAccessGeneration: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  scopes: Schema.fromJsonString(AuthEnvironmentScopes),
  method: ServerAuthSessionMethod,
  clientLabel: Schema.NullOr(Schema.String),
  clientIpAddress: Schema.NullOr(Schema.String),
  clientUserAgent: Schema.NullOr(Schema.String),
  clientDeviceType: Schema.Literals(["desktop", "mobile", "tablet", "bot", "unknown"]),
  clientOs: Schema.NullOr(Schema.String),
  clientBrowser: Schema.NullOr(Schema.String),
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  principalKind: SessionPrincipalKind,
  penMeshId: Schema.NullOr(Schema.String),
  penNodeId: Schema.NullOr(Schema.String),
  penSignPub: Schema.NullOr(Schema.String),
  penNoisePub: Schema.NullOr(Schema.String),
  penMemberNode: Schema.NullOr(Schema.String),
});

const AuthSessionRawDbRow = Schema.Struct({
  sessionId: Schema.String,
  subject: Schema.Unknown,
  connectAccessGeneration: Schema.Unknown,
  scopes: Schema.Unknown,
  method: Schema.Unknown,
  clientLabel: Schema.Unknown,
  clientIpAddress: Schema.Unknown,
  clientUserAgent: Schema.Unknown,
  clientDeviceType: Schema.Unknown,
  clientOs: Schema.Unknown,
  clientBrowser: Schema.Unknown,
  issuedAt: Schema.Unknown,
  expiresAt: Schema.Unknown,
  lastConnectedAt: Schema.Unknown,
  revokedAt: Schema.Unknown,
  principalKind: Schema.Unknown,
  penMeshId: Schema.Unknown,
  penNodeId: Schema.Unknown,
  penSignPub: Schema.Unknown,
  penNoisePub: Schema.Unknown,
  penMemberNode: Schema.Unknown,
});

const decodeAuthSessionDbRow = Schema.decodeUnknownEffect(AuthSessionDbRow);

function toAuthSessionRecord(row: typeof AuthSessionDbRow.Type): AuthSessionRecord {
  return {
    sessionId: row.sessionId,
    subject: row.subject,
    connectAccessGeneration: row.connectAccessGeneration ?? null,
    scopes: row.scopes,
    method: row.method,
    client: {
      label: row.clientLabel,
      ipAddress: row.clientIpAddress,
      userAgent: row.clientUserAgent,
      deviceType: row.clientDeviceType,
      os: row.clientOs,
      browser: row.clientBrowser,
    },
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    lastConnectedAt: row.lastConnectedAt,
    revokedAt: row.revokedAt,
    principalKind: row.principalKind,
    penMemberNode: row.penMemberNode,
    penBinding:
      row.penMeshId !== null &&
      row.penNodeId !== null &&
      row.penSignPub !== null &&
      row.penNoisePub !== null
        ? {
            meshId: row.penMeshId,
            nodeId: row.penNodeId,
            signPub: row.penSignPub,
            noisePub: row.penNoisePub,
          }
        : null,
  };
}

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): AuthSessionRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

/** @public */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const effectiveRevocation = sql`CASE WHEN pen_member_node IS NOT NULL THEN pen_member_revoked_at ELSE revoked_at END`;

  const insertSessionRow = (ignoreExisting: boolean) =>
    SqlSchema.void({
      Request: CreateAuthSessionInput,
      execute: (input) =>
        sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          connect_access_generation,
          scopes,
          method,
          client_label,
          client_ip_address,
          client_user_agent,
          client_device_type,
          client_os,
          client_browser,
          issued_at,
          expires_at,
          revoked_at,
          principal_kind,
          pen_mesh_id,
          pen_node_id,
          pen_sign_pub,
          pen_noise_pub,
          pen_member_node
        )
        VALUES (
          ${input.sessionId},
          ${input.subject},
          ${input.connectAccessGeneration ?? null},
          ${JSON.stringify(input.scopes)},
          ${input.method},
          ${input.client.label},
          ${input.client.ipAddress},
          ${input.client.userAgent},
          ${input.client.deviceType},
          ${input.client.os},
          ${input.client.browser},
          ${input.issuedAt},
          ${input.expiresAt},
          ${input.penMemberNode === undefined ? null : input.issuedAt},
          ${input.principalKind},
          ${input.penBinding?.meshId ?? null},
          ${input.penBinding?.nodeId ?? null},
          ${input.penBinding?.signPub ?? null},
          ${input.penBinding?.noisePub ?? null},
          ${input.penMemberNode ?? null}
        )
        ${ignoreExisting ? sql`ON CONFLICT(session_id) DO NOTHING` : sql``}
      `,
    });
  const createSessionRow = insertSessionRow(false);
  const createSessionRowIfAbsent = insertSessionRow(true);

  const getSessionRowById = SqlSchema.findOneOption({
    Request: GetAuthSessionByIdInput,
    Result: AuthSessionRawDbRow,
    execute: ({ sessionId }) =>
      sql`
        SELECT
          session_id AS "sessionId",
          subject AS "subject",
          connect_access_generation AS "connectAccessGeneration",
          scopes AS "scopes",
          method AS "method",
          client_label AS "clientLabel",
          client_ip_address AS "clientIpAddress",
          client_user_agent AS "clientUserAgent",
          client_device_type AS "clientDeviceType",
          client_os AS "clientOs",
          client_browser AS "clientBrowser",
          issued_at AS "issuedAt",
          expires_at AS "expiresAt",
          last_connected_at AS "lastConnectedAt",
          ${effectiveRevocation} AS "revokedAt",
          principal_kind AS "principalKind",
          pen_mesh_id AS "penMeshId",
          pen_node_id AS "penNodeId",
          pen_sign_pub AS "penSignPub",
          pen_noise_pub AS "penNoisePub",
          pen_member_node AS "penMemberNode"
        FROM auth_sessions
        WHERE session_id = ${sessionId}
      `,
  });

  const revokeActiveSessionsForReplacement = SqlSchema.findAll({
    Request: CreateReplacingActiveAuthSessionInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ session, revokedAt, replaceSessionId }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = CASE WHEN pen_member_node IS NULL THEN ${revokedAt} ELSE revoked_at END,
            pen_member_revoked_at = CASE WHEN pen_member_node IS NOT NULL THEN ${revokedAt} ELSE pen_member_revoked_at END
        WHERE ${
          replaceSessionId === undefined
            ? sql`subject = ${session.subject}`
            : sql`session_id = ${replaceSessionId}`
        }
          AND method = ${session.method}
          AND ${effectiveRevocation} IS NULL
          AND expires_at > ${revokedAt}
        RETURNING session_id AS "sessionId"
      `,
  });

  const listActiveSessionRows = SqlSchema.findAll({
    Request: ListActiveAuthSessionsInput,
    Result: AuthSessionRawDbRow,
    execute: ({ now, connectedSessionIds = [] }) =>
      sql`
        SELECT
          session_id AS "sessionId",
          subject AS "subject",
          connect_access_generation AS "connectAccessGeneration",
          scopes AS "scopes",
          method AS "method",
          client_label AS "clientLabel",
          client_ip_address AS "clientIpAddress",
          client_user_agent AS "clientUserAgent",
          client_device_type AS "clientDeviceType",
          client_os AS "clientOs",
          client_browser AS "clientBrowser",
          issued_at AS "issuedAt",
          expires_at AS "expiresAt",
          last_connected_at AS "lastConnectedAt",
          ${effectiveRevocation} AS "revokedAt",
          principal_kind AS "principalKind",
          pen_mesh_id AS "penMeshId",
          pen_node_id AS "penNodeId",
          pen_sign_pub AS "penSignPub",
          pen_noise_pub AS "penNoisePub",
          pen_member_node AS "penMemberNode"
        FROM auth_sessions
        WHERE ${effectiveRevocation} IS NULL
          AND (expires_at > ${now} OR ${sql.in("session_id", connectedSessionIds)})
        ORDER BY issued_at DESC, session_id DESC
      `,
  });

  const setLastConnectedAtRow = SqlSchema.void({
    Request: SetAuthSessionLastConnectedAtInput,
    execute: ({ sessionId, lastConnectedAt }) =>
      sql`
        UPDATE auth_sessions
        SET last_connected_at = ${lastConnectedAt}
        WHERE session_id = ${sessionId}
          AND ${effectiveRevocation} IS NULL
      `,
  });

  const setClientConnectionRow = SqlSchema.void({
    Request: SetAuthSessionClientConnectionInput,
    execute: ({ sessionId, surface, appVersion }) =>
      sql`
        UPDATE auth_sessions
        SET client_surface = COALESCE(${surface}, client_surface),
            client_app_version = COALESCE(${appVersion}, client_app_version)
        WHERE session_id = ${sessionId}
          AND ${effectiveRevocation} IS NULL
      `,
  });

  const revokeSessionRows = SqlSchema.findAll({
    Request: RevokeAuthSessionInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ sessionId, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = CASE WHEN pen_member_node IS NULL THEN ${revokedAt} ELSE revoked_at END,
            pen_member_revoked_at = CASE WHEN pen_member_node IS NOT NULL THEN ${revokedAt} ELSE pen_member_revoked_at END
        WHERE session_id = ${sessionId}
          AND ${effectiveRevocation} IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  const revokeOtherSessionRows = SqlSchema.findAll({
    Request: RevokeOtherAuthSessionsInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ currentSessionId, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = CASE WHEN pen_member_node IS NULL THEN ${revokedAt} ELSE revoked_at END,
            pen_member_revoked_at = CASE WHEN pen_member_node IS NOT NULL THEN ${revokedAt} ELSE pen_member_revoked_at END
        WHERE session_id <> ${currentSessionId}
          AND ${effectiveRevocation} IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  const penBoundRows = SqlSchema.findAll({
    Request: PenBoundSessionsInput,
    Result: PenBoundSession,
    execute: ({ nodeId }) =>
      sql`
        SELECT
          session_id AS "sessionId",
          pen_node_id AS "nodeId",
          pen_sign_pub AS "signPub",
          pen_noise_pub AS "noisePub"
        FROM auth_sessions
        WHERE pen_node_id IS NOT NULL
          AND ${effectiveRevocation} IS NULL
          ${nodeId === undefined ? sql`` : sql`AND pen_node_id = ${nodeId}`}
      `,
  });

  const penBoundCountRows = SqlSchema.findAll({
    Request: Schema.Struct({ now: Schema.DateTimeUtcFromString, nodeId: Schema.String }),
    Result: Schema.Struct({ member: Schema.Number, total: Schema.Number }),
    execute: ({ now, nodeId }) =>
      sql`
        SELECT
          COALESCE(SUM(CASE WHEN pen_node_id = ${nodeId} THEN 1 ELSE 0 END), 0) AS "member",
          COUNT(*) AS "total"
        FROM auth_sessions
        WHERE pen_node_id IS NOT NULL
          AND ${effectiveRevocation} IS NULL
          AND expires_at > ${now}
      `,
  });

  const deletePenBoundRows = SqlSchema.findAll({
    Request: PenBoundSessionsInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ now }) =>
      sql`
        DELETE FROM auth_sessions
        WHERE pen_node_id IS NOT NULL
          AND (${effectiveRevocation} IS NOT NULL OR expires_at <= ${now})
        RETURNING session_id AS "sessionId"
      `,
  });

  const penError = (operation: string) =>
    toPersistenceSqlOrDecodeError(
      `AuthSessionRepository.${operation}:query`,
      `AuthSessionRepository.${operation}:decodeRows`,
    );
  const listPenBound: AuthSessionRepository["Service"]["listPenBound"] = (input) =>
    penBoundRows(input).pipe(Effect.mapError(penError("listPenBound")));
  const countActivePenBound: AuthSessionRepository["Service"]["countActivePenBound"] = (input) =>
    penBoundCountRows(input).pipe(
      Effect.mapError(penError("countActivePenBound")),
      Effect.map((rows) => rows[0] ?? { member: 0, total: 0 }),
    );
  const deleteInactivePenBound: AuthSessionRepository["Service"]["deleteInactivePenBound"] = (
    input,
  ) =>
    deletePenBoundRows(input).pipe(
      Effect.mapError(penError("deleteInactivePenBound")),
      Effect.map((rows) => rows.length),
    );

  const create: AuthSessionRepository["Service"]["create"] = (input) =>
    createSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.create:query",
          "AuthSessionRepository.create:encodeRequest",
          { sessionId: input.sessionId },
        ),
      ),
    );

  const createReplacingActive: AuthSessionRepository["Service"]["createReplacingActive"] = (
    input,
  ) =>
    sql
      .withTransaction(
        revokeActiveSessionsForReplacement(input).pipe(
          Effect.flatMap((revokedRows) =>
            createSessionRow(input.session).pipe(
              Effect.as(revokedRows.map((row) => row.sessionId)),
            ),
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "AuthSessionRepository.createReplacingActive:query",
            "AuthSessionRepository.createReplacingActive:encodeRequest",
            { sessionId: input.session.sessionId },
          ),
        ),
      );

  const createIfAbsent: AuthSessionRepository["Service"]["createIfAbsent"] = (input) =>
    createSessionRowIfAbsent(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.createIfAbsent:query",
          "AuthSessionRepository.createIfAbsent:encodeRequest",
          { sessionId: input.sessionId },
        ),
      ),
    );

  const getById: AuthSessionRepository["Service"]["getById"] = (input) =>
    getSessionRowById(input).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.getById:query",
          "AuthSessionRepository.getById:decodeRow",
          { sessionId: input.sessionId },
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeedNone,
          onSome: (row) =>
            decodeAuthSessionDbRow(row).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "AuthSessionRepository.getById:decodeRow",
                  cause,
                  { sessionId: input.sessionId },
                ),
              ),
              Effect.map((decodedRow) => Option.some(toAuthSessionRecord(decodedRow))),
            ),
        }),
      ),
    );

  const listActive: AuthSessionRepository["Service"]["listActive"] = (input) =>
    listActiveSessionRows(input).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.listActive:query",
          "AuthSessionRepository.listActive:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeAuthSessionDbRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "AuthSessionRepository.listActive:decodeRows",
                cause,
                { sessionId: row.sessionId },
              ),
            ),
            Effect.map(toAuthSessionRecord),
          ),
        ),
      ),
    );

  const revoke: AuthSessionRepository["Service"]["revoke"] = (input) =>
    revokeSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revoke:query",
          "AuthSessionRepository.revoke:decodeRows",
          { sessionId: input.sessionId },
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const revokeAllExcept: AuthSessionRepository["Service"]["revokeAllExcept"] = (input) =>
    revokeOtherSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revokeAllExcept:query",
          "AuthSessionRepository.revokeAllExcept:decodeRows",
          { currentSessionId: input.currentSessionId },
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.sessionId)),
    );

  const setLastConnectedAt: AuthSessionRepository["Service"]["setLastConnectedAt"] = (input) =>
    setLastConnectedAtRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.setLastConnectedAt:query",
          "AuthSessionRepository.setLastConnectedAt:encodeRequest",
          { sessionId: input.sessionId },
        ),
      ),
    );

  const setClientConnection: AuthSessionRepository["Service"]["setClientConnection"] = (input) =>
    setClientConnectionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.setClientConnection:query",
          "AuthSessionRepository.setClientConnection:encodeRequest",
          { sessionId: input.sessionId },
        ),
      ),
    );

  return {
    listPenBound,
    countActivePenBound,
    deleteInactivePenBound,
    create,
    createReplacingActive,
    createIfAbsent,
    getById,
    listActive,
    revoke,
    revokeAllExcept,
    setLastConnectedAt,
    setClientConnection,
  } satisfies AuthSessionRepository["Service"];
});

export const layer = Layer.effect(AuthSessionRepository, make);
