//! Client-side permission policy for ACP agents.
//!
//! v1: `packages/provider-acp/src/server/clientPolicy.ts` (disposition, changed paths, workspace
//! containment) and `permissionOptions.ts` (option selection). GOAT 2 threads carry a runtime mode
//! and a cwd; v1's optional `approvalPolicy` / `sandboxPolicy` are never set, so the branches for
//! them reduce to v1's `undefined` cases.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use goat2_contracts::RuntimeMode;
use serde_json::{Value, json};

/// v1 `AcpPermissionDisposition`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    Allow,
    Ask,
    Deny,
}

/// v1 `AcpRuntimePolicy` as GOAT 2 has it.
#[derive(Debug, Clone)]
pub struct RuntimePolicy {
    pub runtime_mode: RuntimeMode,
    pub cwd: Option<String>,
    pub extra_roots: Vec<String>,
}

/// v1 `AcpChangedPaths`: the paths a change touches, or unknown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangedPaths {
    Known(Vec<String>),
    Unknown,
}

const MAX_ACP_CHANGED_PATHS: usize = 256;

/// v1 `ACP_RAW_INPUT_PATH_KEYS`.
pub const ACP_RAW_INPUT_PATH_KEYS: [&str; 3] = ["path", "filePath", "file_path"];

fn has_url_scheme(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-') {
            return false;
        }
    }
    false
}

/// v1 `acpCheckablePath`.
fn checkable_path(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    if value.trim().is_empty() || value.contains('\0') {
        return None;
    }
    if Path::new(value).is_absolute() {
        return Some(value.to_owned());
    }
    if value.starts_with('~') || has_url_scheme(value) {
        return None;
    }
    if cfg!(unix) && value.contains('\\') {
        return None;
    }
    Some(value.to_owned())
}

/// v1 `acpChangedPathsOfToolCall` (clientPolicy.ts:139-209).
pub fn changed_paths_of_tool_call(tool_call: &Value) -> ChangedPaths {
    let mut paths: Vec<String> = Vec::new();
    let mut complete = true;
    let mut require = |value: Option<&Value>, paths: &mut Vec<String>| match checkable_path(value) {
        Some(path) => {
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
        None => complete = false,
    };
    match tool_call.get("locations") {
        Some(Value::Array(locations)) => {
            for location in locations {
                require(location.get("path"), &mut paths);
            }
        }
        None | Some(Value::Null) => {}
        Some(_) => require(None, &mut paths),
    }
    match tool_call.get("content") {
        Some(Value::Array(content)) => {
            for entry in content {
                match entry.get("type").and_then(Value::as_str) {
                    Some("content") | Some("terminal") => continue,
                    Some("diff") => {}
                    _ => {
                        require(None, &mut paths);
                        continue;
                    }
                }
                match entry.get("changes") {
                    None | Some(Value::Null) => require(entry.get("path"), &mut paths),
                    Some(Value::Array(changes)) => {
                        if entry.get("path").is_some_and(|p| !p.is_null()) {
                            require(entry.get("path"), &mut paths);
                        }
                        for change in changes {
                            match change.get("operation").and_then(Value::as_str) {
                                Some("move") => {
                                    require(change.get("oldPath"), &mut paths);
                                    require(change.get("path"), &mut paths);
                                }
                                Some("add" | "delete" | "modify" | "copy") => {
                                    require(change.get("path"), &mut paths)
                                }
                                _ => require(None, &mut paths),
                            }
                        }
                    }
                    Some(_) => require(None, &mut paths),
                }
            }
        }
        None | Some(Value::Null) => {}
        Some(_) => require(None, &mut paths),
    }
    if let Some(input) = tool_call.get("rawInput").and_then(Value::as_object) {
        for key in ACP_RAW_INPUT_PATH_KEYS {
            if let Some(value) = input.get(key).filter(|v| !v.is_null()) {
                require(Some(value), &mut paths);
            }
        }
    }
    if complete && paths.len() <= MAX_ACP_CHANGED_PATHS {
        ChangedPaths::Known(paths)
    } else {
        ChangedPaths::Unknown
    }
}

/// v1 `mergeAcpChangedPaths` (clientPolicy.ts:98-107) and `changedPathsField` (runtimeModel.ts:936-938):
/// every path either side named, unknown if either is; None when no path is named.
pub fn merge_changed_paths(
    left: Option<ChangedPaths>,
    right: ChangedPaths,
) -> Option<ChangedPaths> {
    let merged = match (left, right) {
        (Some(ChangedPaths::Unknown), _) | (_, ChangedPaths::Unknown) => ChangedPaths::Unknown,
        (None, known) => known,
        (Some(ChangedPaths::Known(mut left)), ChangedPaths::Known(right)) => {
            for path in right {
                if !left.contains(&path) {
                    left.push(path);
                }
            }
            if left.len() > MAX_ACP_CHANGED_PATHS {
                ChangedPaths::Unknown
            } else {
                ChangedPaths::Known(left)
            }
        }
    };
    match merged {
        ChangedPaths::Known(paths) if paths.is_empty() => None,
        other => Some(other),
    }
}

/// v1 `autoAcceptPolicyRequest` with `withTrackedChangedPaths` (autoAcceptEdits.ts:21-32,148-160): the
/// permission request as policy reads it. The kind comes from the tracked call when the request
/// has none, and the paths earlier updates of the same call named join the request's locations;
/// when those are unknown (or the call had an update the driver could not read, `unread`) a
/// location without a path makes the request's paths unknown (final review finding 2).
pub fn auto_accept_policy_request(
    request: &Value,
    tracked_kind: Option<&str>,
    tracked_paths: Option<&ChangedPaths>,
    unread: bool,
) -> Value {
    let mut request = request.clone();
    let Some(tool_call) = request.get_mut("toolCall").and_then(Value::as_object_mut) else {
        return request;
    };
    if tool_call.get("kind").is_none_or(Value::is_null)
        && let Some(kind) = tracked_kind
    {
        tool_call.insert("kind".into(), json!(kind));
    }
    let seen = if unread {
        Some(&ChangedPaths::Unknown)
    } else {
        tracked_paths
    };
    let unreadable = || vec![json!({ "path": "" })];
    let locations = match (seen, tool_call.get("locations")) {
        (None, _) => return request,
        (Some(ChangedPaths::Known(paths)), _) if paths.is_empty() => return request,
        (Some(ChangedPaths::Unknown), _) => unreadable(),
        (Some(ChangedPaths::Known(_)), Some(own)) if !own.is_null() && !own.is_array() => {
            unreadable()
        }
        (Some(ChangedPaths::Known(paths)), own) => own
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .chain(paths.iter().map(|path| json!({ "path": path })))
            .collect(),
    };
    tool_call.insert("locations".into(), Value::Array(locations));
    request
}

/// v1 `MAX_UNREAD_TOOL_CALLS` (autoAcceptEdits.ts:63).
pub const MAX_UNREAD_TOOL_CALLS: usize = 4096;

/// v1 `makeAcpUnreadToolCalls` (autoAcceptEdits.ts:71-131): the tool calls of the session that had an
/// update the driver could not read, so the paths they changed are not all known. Entries are
/// never removed; an update naming no tool call taints its whole session (every session when it
/// names none either), and past the cap every tool call counts.
#[derive(Debug, Default)]
pub struct UnreadToolCalls {
    every_tool_everywhere: bool,
    every_tool_in: HashSet<String>,
    by_session: HashMap<Option<String>, HashSet<String>>,
    size: usize,
}

impl UnreadToolCalls {
    fn saturate(&mut self) {
        self.every_tool_everywhere = true;
        self.by_session.clear();
        self.every_tool_in.clear();
    }

    /// Record what an unreadable update named (v1 `add`).
    pub fn add(&mut self, session_id: Option<&str>, tool_call_id: Option<&str>) {
        if self.every_tool_everywhere || self.size > MAX_UNREAD_TOOL_CALLS {
            return;
        }
        let Some(tool_call_id) = tool_call_id else {
            let Some(session) = session_id else {
                self.saturate();
                return;
            };
            if self.every_tool_in.contains(session) {
                return;
            }
            if let Some(previous) = self.by_session.remove(&Some(session.to_owned())) {
                self.size -= previous.len();
            }
            if self.size >= MAX_UNREAD_TOOL_CALLS {
                self.size = MAX_UNREAD_TOOL_CALLS + 1;
                self.saturate();
                return;
            }
            self.every_tool_in.insert(session.to_owned());
            self.size += 1;
            return;
        };
        if session_id.is_some_and(|s| self.every_tool_in.contains(s)) {
            return;
        }
        let key = session_id.map(str::to_owned);
        if self
            .by_session
            .get(&key)
            .is_some_and(|ids| ids.contains(tool_call_id))
        {
            return;
        }
        if self.size >= MAX_UNREAD_TOOL_CALLS {
            self.size = MAX_UNREAD_TOOL_CALLS + 1;
            self.saturate();
            return;
        }
        self.by_session
            .entry(key)
            .or_default()
            .insert(tool_call_id.to_owned());
        self.size += 1;
    }

    /// v1 `has`.
    pub fn has(&self, session_id: &str, tool_call_id: &str) -> bool {
        self.every_tool_everywhere
            || self.size > MAX_UNREAD_TOOL_CALLS
            || self.every_tool_in.contains(session_id)
            || self
                .by_session
                .get(&Some(session_id.to_owned()))
                .is_some_and(|ids| ids.contains(tool_call_id))
            || self
                .by_session
                .get(&None)
                .is_some_and(|ids| ids.contains(tool_call_id))
    }
}

/// v1 `unreadToolCallUpdate` (autoAcceptEdits.ts:44-60) for the updates the driver cannot read as
/// tool updates: a `sessionUpdate` that is not a string (it may have been a tool call), or a tool
/// update without a tool call id. Returns the session and tool call it named, each None when it
/// is not a non-empty string; None for a readable update.
pub fn unread_tool_call_update(params: &Value) -> Option<(Option<String>, Option<String>)> {
    let text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let update = params.get("update");
    let tool_call_id = text(update.and_then(|u| u.get("toolCallId")));
    match update
        .and_then(|u| u.get("sessionUpdate"))
        .and_then(Value::as_str)
    {
        Some("tool_call" | "tool_call_update" | "tool_call_content_chunk")
            if tool_call_id.is_none() => {}
        Some(_) => return None,
        None => {}
    }
    Some((text(params.get("sessionId")), tool_call_id))
}

fn resolve_permission_path(path: &str, cwd: Option<&str>) -> Option<PathBuf> {
    if path.trim().is_empty() {
        return None;
    }
    if Path::new(path).is_absolute() {
        return Some(PathBuf::from(path));
    }
    let cwd = cwd.filter(|c| !c.trim().is_empty())?;
    Some(Path::new(cwd).join(path))
}

/// v1 `acpCanonicalPathForContainment`: realpath of the deepest existing ancestor plus the
/// missing suffix; fails closed on anything but "does not exist".
fn canonical_for_containment(path: &Path) -> Option<PathBuf> {
    let mut candidate = path.to_path_buf();
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match std::fs::canonicalize(&candidate) {
            Ok(real) => {
                let mut out = real;
                for part in missing.iter().rev() {
                    out.push(part);
                }
                return Some(normalize_lexically(&out));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
        if std::fs::symlink_metadata(&candidate).is_ok() {
            // Exists (dangling symlink) but cannot be resolved.
            return None;
        }
        let name = candidate.file_name()?.to_os_string();
        missing.push(name);
        if !candidate.pop() {
            return None;
        }
    }
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn within_root(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

/// v1 `acpMutationStaysInWorkspace` with no sandbox writable roots.
fn mutation_stays_in_workspace(policy: &RuntimePolicy, changed: &ChangedPaths) -> bool {
    let ChangedPaths::Known(paths) = changed else {
        return false;
    };
    if paths.is_empty() {
        return false;
    }
    let cwd = policy.cwd.as_deref().filter(|c| !c.trim().is_empty());
    let mut roots = Vec::new();
    if let Some(cwd) = cwd
        && let Some(root) = canonical_for_containment(Path::new(cwd))
    {
        roots.push(root);
    }
    for extra in &policy.extra_roots {
        if let Some(resolved) = resolve_permission_path(extra, cwd)
            && let Some(root) = canonical_for_containment(&resolved)
        {
            roots.push(root);
        }
    }
    if roots.is_empty() {
        return false;
    }
    paths.iter().all(|changed| {
        resolve_permission_path(changed, cwd)
            .and_then(|p| canonical_for_containment(&p))
            .is_some_and(|canonical| roots.iter().any(|root| within_root(&canonical, root)))
    })
}

fn is_read_kind(kind: &str) -> bool {
    matches!(kind, "read" | "search" | "think")
}

fn is_mutation_kind(kind: &str) -> bool {
    matches!(kind, "edit" | "delete" | "move")
}

/// v1 `acpOperationDisposition` for GOAT 2's policy (no approval or sandbox policy).
pub fn operation_disposition(
    policy: &RuntimePolicy,
    kind: Option<&str>,
    changed: &ChangedPaths,
) -> Disposition {
    let kind = kind.unwrap_or("other");
    if is_read_kind(kind) {
        return Disposition::Allow;
    }
    match policy.runtime_mode {
        RuntimeMode::ApprovalRequired => Disposition::Ask,
        // Auto-accept covers file changes in the thread's own folders; the user decides the rest.
        RuntimeMode::AutoAcceptEdits => {
            if is_mutation_kind(kind) && mutation_stays_in_workspace(policy, changed) {
                Disposition::Allow
            } else {
                Disposition::Ask
            }
        }
        RuntimeMode::Auto | RuntimeMode::FullAccess => Disposition::Allow,
    }
}

/// v1 `acpPermissionDisposition` (clientPolicy.ts:330-338). `tool_call` is the request's `toolCall`.
pub fn permission_disposition(policy: &RuntimePolicy, tool_call: &Value) -> Disposition {
    operation_disposition(
        policy,
        tool_call.get("kind").and_then(Value::as_str),
        &changed_paths_of_tool_call(tool_call),
    )
}

/// v1 `acpMcpToolApprovalElicitationDisposition` (clientPolicy.ts:340-357).
pub fn mcp_tool_approval_elicitation_disposition(
    policy: &RuntimePolicy,
    request: &Value,
    native_request_id: Option<&str>,
) -> Option<Disposition> {
    let is_mcp_approval = request.get("mode").and_then(Value::as_str) == Some("form")
        && (request
            .get("_meta")
            .and_then(|m| m.get("codex_approval_kind"))
            .and_then(Value::as_str)
            == Some("mcp_tool_call")
            || native_request_id.is_some_and(|id| id.starts_with("mcp_tool_call_approval_")));
    if !is_mcp_approval {
        return None;
    }
    Some(if policy.runtime_mode == RuntimeMode::ApprovalRequired {
        Disposition::Ask
    } else {
        Disposition::Allow
    })
}

/// The decisions a person can make on a permission request (v1 `ProviderApprovalDecision` minus cancel).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionChoice {
    Accept,
    AcceptForSession,
    Decline,
}

fn option_id_of_kind<'a>(options: &'a [Value], kind: &str) -> Option<&'a str> {
    options
        .iter()
        .find(|option| option.get("kind").and_then(Value::as_str) == Some(kind))
        .and_then(|option| option.get("optionId").and_then(Value::as_str))
}

/// v1 `selectPermissionOptionId` (permissionOptions.ts:4-15).
pub fn select_permission_option_id(options: &[Value], choice: PermissionChoice) -> Option<String> {
    match choice {
        // Agents may offer only allow_once, and answering "cancelled" would stop the turn.
        PermissionChoice::AcceptForSession => option_id_of_kind(options, "allow_always")
            .or_else(|| option_id_of_kind(options, "allow_once")),
        PermissionChoice::Accept => option_id_of_kind(options, "allow_once"),
        PermissionChoice::Decline => option_id_of_kind(options, "reject_once"),
    }
    .map(str::to_owned)
}

/// v1 `selectAutoApprovedPermissionOption`: prefer allow-once; allow-always can persist.
pub fn select_auto_approved_option(options: &[Value]) -> Option<String> {
    select_permission_option_id(options, PermissionChoice::Accept)
        .or_else(|| select_permission_option_id(options, PermissionChoice::AcceptForSession))
}

/// v1 `acpModeAllowed`.
pub fn mode_allowed(mode: Option<RuntimeMode>, ceiling: RuntimeMode) -> bool {
    fn rank(mode: RuntimeMode) -> u8 {
        match mode {
            RuntimeMode::ApprovalRequired => 0,
            RuntimeMode::AutoAcceptEdits => 1,
            RuntimeMode::Auto => 2,
            RuntimeMode::FullAccess => 3,
        }
    }
    mode.is_some_and(|mode| rank(mode) <= rank(ceiling))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn policy(mode: RuntimeMode, cwd: &str) -> RuntimePolicy {
        RuntimePolicy {
            runtime_mode: mode,
            cwd: Some(cwd.to_owned()),
            extra_roots: vec![],
        }
    }

    #[test]
    fn reads_never_ask() {
        let p = policy(RuntimeMode::ApprovalRequired, "/tmp");
        assert_eq!(
            permission_disposition(&p, &json!({"kind": "read"})),
            Disposition::Allow
        );
        assert_eq!(
            permission_disposition(&p, &json!({"kind": "execute"})),
            Disposition::Ask
        );
    }

    #[test]
    fn auto_accept_edits_only_inside_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        let p = policy(RuntimeMode::AutoAcceptEdits, cwd);
        let inside = json!({"kind": "edit", "locations": [{"path": format!("{cwd}/a/new.txt")}]});
        let outside = json!({"kind": "edit", "locations": [{"path": "/etc/passwd"}]});
        let traversal = json!({"kind": "edit", "rawInput": {"path": "../x"}});
        assert_eq!(permission_disposition(&p, &inside), Disposition::Allow);
        assert_eq!(permission_disposition(&p, &outside), Disposition::Ask);
        assert_eq!(permission_disposition(&p, &traversal), Disposition::Ask);
        assert_eq!(
            permission_disposition(&p, &json!({"kind": "execute"})),
            Disposition::Ask
        );
    }

    #[test]
    fn unknown_diff_shapes_are_unknown() {
        let call = json!({"content": [{"type": "diff", "changes": [{"operation": "chmod", "path": "a"}]}]});
        assert_eq!(changed_paths_of_tool_call(&call), ChangedPaths::Unknown);
        let tilde = json!({"rawInput": {"path": "~/x"}});
        assert_eq!(changed_paths_of_tool_call(&tilde), ChangedPaths::Unknown);
    }

    #[test]
    fn option_selection_matches_v1() {
        let options = vec![
            json!({"optionId": "once", "kind": "allow_once", "name": "Allow"}),
            json!({"optionId": "no", "kind": "reject_once", "name": "Reject"}),
        ];
        assert_eq!(
            select_permission_option_id(&options, PermissionChoice::AcceptForSession).as_deref(),
            Some("once")
        );
        assert_eq!(
            select_permission_option_id(&options, PermissionChoice::Decline).as_deref(),
            Some("no")
        );
        assert_eq!(
            select_auto_approved_option(&options).as_deref(),
            Some("once")
        );
    }

    /// Final review finding 2 (v1 autoAcceptEdits.ts:21-32,71-131,148-160).
    #[test]
    fn tracked_paths_and_unread_updates_reach_policy() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        let p = policy(RuntimeMode::AutoAcceptEdits, cwd);
        let inside = format!("{cwd}/a.txt");
        let request = json!({"sessionId": "s", "toolCall": {"toolCallId": "t", "locations": [{"path": inside}]}});
        let seen =
            |paths: &[&str]| ChangedPaths::Known(paths.iter().map(|p| p.to_string()).collect());
        let decide = |kind: Option<&str>, paths: Option<&ChangedPaths>, unread: bool| {
            permission_disposition(
                &p,
                &auto_accept_policy_request(&request, kind, paths, unread)["toolCall"],
            )
        };
        // The request has no kind: the tracked one counts.
        assert_eq!(decide(Some("edit"), None, false), Disposition::Allow);
        assert_eq!(decide(None, None, false), Disposition::Ask);
        let outside = seen(&["/etc/passwd"]);
        assert_eq!(
            decide(Some("edit"), Some(&outside), false),
            Disposition::Ask
        );
        assert_eq!(
            decide(Some("edit"), Some(&seen(&[inside.as_str()])), false),
            Disposition::Allow
        );
        assert_eq!(
            decide(Some("edit"), Some(&ChangedPaths::Unknown), false),
            Disposition::Ask
        );
        assert_eq!(decide(Some("edit"), None, true), Disposition::Ask);
        // Paths only grow; past the cap they are unknown.
        let merged = merge_changed_paths(Some(seen(&["a"])), seen(&["b", "a"]));
        assert_eq!(merged, Some(seen(&["a", "b"])));
        assert_eq!(merge_changed_paths(None, seen(&[])), None);
        assert_eq!(
            merge_changed_paths(merged, ChangedPaths::Unknown),
            Some(ChangedPaths::Unknown)
        );
        let many: Vec<String> = (0..=MAX_ACP_CHANGED_PATHS).map(|i| i.to_string()).collect();
        assert_eq!(
            merge_changed_paths(Some(seen(&["x"])), ChangedPaths::Known(many)),
            Some(ChangedPaths::Unknown)
        );
        // Unreadable updates.
        assert_eq!(
            unread_tool_call_update(
                &json!({"sessionId": "s", "update": {"sessionUpdate": "tool_call"}})
            ),
            Some((Some("s".into()), None))
        );
        assert_eq!(
            unread_tool_call_update(&json!({"update": {"sessionUpdate": 3, "toolCallId": "t"}})),
            Some((None, Some("t".into())))
        );
        assert_eq!(
            unread_tool_call_update(
                &json!({"sessionId": "s", "update": {"sessionUpdate": "tool_call", "toolCallId": "t"}})
            ),
            None
        );
        assert_eq!(
            unread_tool_call_update(
                &json!({"sessionId": "s", "update": {"sessionUpdate": "plan"}})
            ),
            None
        );
        let mut unread = UnreadToolCalls::default();
        unread.add(Some("s"), Some("t"));
        assert!(unread.has("s", "t") && !unread.has("s", "u") && !unread.has("o", "t"));
        unread.add(None, Some("u"));
        assert!(unread.has("o", "u"));
        unread.add(Some("s"), None);
        assert!(unread.has("s", "anything") && !unread.has("o", "anything"));
        unread.add(None, None);
        assert!(unread.has("o", "anything"));
        let mut capped = UnreadToolCalls::default();
        for i in 0..=MAX_UNREAD_TOOL_CALLS {
            capped.add(Some("s"), Some(&i.to_string()));
        }
        assert!(capped.has("other", "never-seen"));
    }
}
