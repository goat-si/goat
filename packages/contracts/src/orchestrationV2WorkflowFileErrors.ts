import * as Schema from "effect/Schema";

const WORKFLOW_FILE_ERROR_MESSAGES = {
  "invalid-path": "Workflow files must be absolute paths with the expected extension.",
  "root-unavailable": "Workflow file root unavailable.",
  "not-found": "Workflow file not found.",
  "outside-root": "Path is outside the workflow files root.",
  "wrong-extension": "Resolved file has the wrong extension.",
  "not-regular-file": "Workflow file is not a regular file.",
  "changed-during-read": "Workflow file changed between resolution and open.",
  "read-failed": "Workflow file read failed.",
} as const;

export class OrchestrationWorkflowFileError extends Schema.TaggedError<OrchestrationWorkflowFileError>()(
  "OrchestrationWorkflowFileError",
  {
    reason: Schema.Literals([
      "invalid-path",
      "root-unavailable",
      "not-found",
      "outside-root",
      "wrong-extension",
      "not-regular-file",
      "changed-during-read",
      "read-failed",
    ]),
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return WORKFLOW_FILE_ERROR_MESSAGES[this.reason];
  }
}

const WORKFLOW_SCRIPT_ERROR_MESSAGES = {
  "invalid-path": "Workflow scripts must be absolute .js paths.",
  "root-unavailable": "Script root unavailable.",
  "not-found": "Script not found.",
  "outside-root": "Script path is outside the workflow scripts root.",
  "not-js": "Resolved script is not a .js file.",
  "not-regular-file": "Script is not a regular file.",
  "changed-during-read": "Script changed between resolution and open.",
  "read-failed": "Script read failed.",
} as const;

export class OrchestrationGetWorkflowScriptError extends Schema.TaggedError<OrchestrationGetWorkflowScriptError>()(
  "OrchestrationGetWorkflowScriptError",
  {
    reason: Schema.Literals([
      "invalid-path",
      "root-unavailable",
      "not-found",
      "outside-root",
      "not-js",
      "not-regular-file",
      "changed-during-read",
      "read-failed",
    ]),
    scriptPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return WORKFLOW_SCRIPT_ERROR_MESSAGES[this.reason];
  }
}
