use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::agents::CodingAgent;
use crate::attention::{AgentEvent, SessionStatus};
use crate::json::{parse_json, JsonValue};

const HERMES_NEEDS_INPUT_PREFIX: &str = "petdex:needs-input:";
const MAX_SCAN_DEPTH: usize = 6;
const MAX_ENTRIES_PER_ROOT: usize = 512;
const MAX_SESSION_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconciledSession {
    pub session_id: String,
    pub agent: CodingAgent,
    pub status: SessionStatus,
    pub title: Option<String>,
    pub summary: String,
}

impl ReconciledSession {
    pub fn into_agent_event(self) -> AgentEvent {
        AgentEvent {
            session_id: self.session_id,
            agent: self.agent,
            status: self.status,
            summary: self.summary,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconcileError {
    Io(String),
    Parse(String),
    UnsupportedAgent(CodingAgent),
}

impl fmt::Display for ReconcileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReconcileError::Io(msg) => write!(f, "io error: {msg}"),
            ReconcileError::Parse(msg) => write!(f, "parse error: {msg}"),
            ReconcileError::UnsupportedAgent(agent) => {
                write!(f, "unsupported durable reconcile agent: {}", agent.spec().slug)
            }
        }
    }
}

impl std::error::Error for ReconcileError {}

pub fn reconcile_file(agent: CodingAgent, path: &Path) -> Result<ReconciledSession, ReconcileError> {
    let content = fs::read_to_string(path).map_err(|e| ReconcileError::Io(e.to_string()))?;
    match agent {
        CodingAgent::ClaudeCode => parse_claude_jsonl(&content),
        CodingAgent::Gemini => parse_gemini_jsonl(&content),
        CodingAgent::Omp => parse_omp_jsonl(&content),
        CodingAgent::Hermes => parse_hermes_json(&content),
        other => Err(ReconcileError::UnsupportedAgent(other)),
    }
}

pub fn reconcile_local_sessions(home: &Path) -> Vec<AgentEvent> {
    let targets: [(CodingAgent, PathBuf, &str); 4] = [
        (
            CodingAgent::ClaudeCode,
            home.join(".claude").join("projects"),
            "jsonl",
        ),
        (
            CodingAgent::Gemini,
            home.join(".gemini").join("tmp"),
            "jsonl",
        ),
        (CodingAgent::Omp, home.join(".omp"), "jsonl"),
        (CodingAgent::Hermes, home.join(".hermes"), "json"),
    ];

    let mut events = Vec::new();
    for (agent, root, ext) in targets {
        let Some(latest_path) = find_most_recent_session_file(&root, ext) else {
            continue;
        };
        if let Ok(session) = reconcile_file(agent, &latest_path) {
            if session.status != SessionStatus::Idle {
                events.push(session.into_agent_event());
            }
        }
    }
    events
}

fn find_most_recent_session_file(root: &Path, expected_ext: &str) -> Option<PathBuf> {
    let meta = fs::symlink_metadata(root).ok()?;
    if !meta.is_dir() {
        return None;
    }

    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    let mut visited: usize = 0;
    let mut best: Option<(SystemTime, PathBuf)> = None;

    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry_res in entries {
            if visited >= MAX_ENTRIES_PER_ROOT {
                return best.map(|(_, p)| p);
            }
            visited += 1;

            let Ok(entry) = entry_res else {
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();

            if file_type.is_dir() {
                if depth < MAX_SCAN_DEPTH {
                    stack.push((path, depth + 1));
                }
                continue;
            }

            if !file_type.is_file() {
                continue;
            }

            let ext_matches = path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case(expected_ext));
            if !ext_matches {
                continue;
            }

            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.len() > MAX_SESSION_FILE_BYTES {
                continue;
            }
            let Ok(modified) = metadata.modified() else {
                continue;
            };

            let replace = match &best {
                None => true,
                Some((best_time, _)) => modified > *best_time,
            };
            if replace {
                best = Some((modified, path));
            }
        }
    }

    best.map(|(_, p)| p)
}

pub fn parse_claude_jsonl(input: &str) -> Result<ReconciledSession, ReconcileError> {
    let mut session_id = String::new();
    let mut status = SessionStatus::Idle;
    let mut summary = String::new();

    for line in non_empty_lines(input) {
        let value = parse_json(line).map_err(ReconcileError::Parse)?;
        if value.get("_fixture").is_some() {
            continue;
        }

        if let Some(sid) = value.get_str("sessionId") {
            if !sid.is_empty() {
                session_id = sid.to_string();
            }
        }

        let record_type = value.get_str("type").unwrap_or("");
        let message = value.get("message");
        let role = message.and_then(|m| m.get_str("role")).unwrap_or(record_type);

        match role {
            "user" => {
                status = SessionStatus::Running;
                if let Some(text) = message.and_then(|m| extract_text_content(m.get("content"))) {
                    summary = text;
                }
            }
            "assistant" => {
                let stop_reason = message.and_then(|m| m.get_str("stop_reason")).unwrap_or("");
                status = match stop_reason {
                    "end_turn" | "stop_sequence" | "max_tokens" => SessionStatus::Completed,
                    "tool_use" => SessionStatus::Running,
                    "error" => SessionStatus::Failed,
                    _ => SessionStatus::Completed,
                };
                if let Some(text) = message.and_then(|m| extract_text_content(m.get("content"))) {
                    summary = text;
                }
            }
            "error" => {
                status = SessionStatus::Failed;
            }
            _ => {}
        }
    }

    if session_id.is_empty() {
        return Err(ReconcileError::Parse(
            "claude jsonl missing sessionId".to_string(),
        ));
    }

    Ok(ReconciledSession {
        session_id,
        agent: CodingAgent::ClaudeCode,
        status,
        title: None,
        summary,
    })
}

pub fn parse_gemini_jsonl(input: &str) -> Result<ReconciledSession, ReconcileError> {
    let mut session_id = String::new();
    let mut title: Option<String> = None;
    let mut status = SessionStatus::Idle;
    let mut summary = String::new();

    for line in non_empty_lines(input) {
        let value = parse_json(line).map_err(ReconcileError::Parse)?;
        if value.get("_fixture").is_some() {
            continue;
        }

        if let Some(sid) = value.get_str("sessionId") {
            if !sid.is_empty() {
                session_id = sid.to_string();
            }
            if let Some(s) = value.get_str("summary") {
                if !s.is_empty() {
                    title = Some(s.to_string());
                }
            }
            continue;
        }

        let record_type = value.get_str("type").unwrap_or("");
        match record_type {
            "user" => {
                status = SessionStatus::Running;
                if let Some(text) = extract_text_content(value.get("content")) {
                    summary = text;
                }
            }
            "gemini" | "model" | "assistant" => {
                status = SessionStatus::Completed;
                if let Some(text) = extract_text_content(value.get("content")) {
                    summary = text;
                }
            }
            "error" => {
                status = SessionStatus::Failed;
            }
            _ => {}
        }
    }

    if session_id.is_empty() {
        return Err(ReconcileError::Parse(
            "gemini jsonl missing sessionId".to_string(),
        ));
    }

    if summary.is_empty() {
        if let Some(ref t) = title {
            summary = t.clone();
        }
    }

    Ok(ReconciledSession {
        session_id,
        agent: CodingAgent::Gemini,
        status,
        title,
        summary,
    })
}

pub fn parse_omp_jsonl(input: &str) -> Result<ReconciledSession, ReconcileError> {
    let mut session_id = String::new();
    let mut title: Option<String> = None;
    let mut status = SessionStatus::Idle;
    let mut summary = String::new();

    for line in non_empty_lines(input) {
        let value = parse_json(line).map_err(ReconcileError::Parse)?;
        if value.get("_fixture").is_some() {
            continue;
        }

        match value.get_str("type").unwrap_or("") {
            "session" => {
                if let Some(id) = value.get_str("id") {
                    session_id = id.to_string();
                }
            }
            "session_info" => {
                if let Some(name) = value.get_str("name") {
                    if !name.is_empty() {
                        title = Some(name.to_string());
                    }
                }
            }
            "message" => {
                if let Some(msg) = value.get("message") {
                    match msg.get_str("role").unwrap_or("") {
                        "user" => {
                            status = SessionStatus::Running;
                            if let Some(text) = extract_text_content(msg.get("content")) {
                                summary = text;
                            }
                        }
                        "assistant" => {
                            status = SessionStatus::Completed;
                            if let Some(text) = extract_text_content(msg.get("content")) {
                                summary = text;
                            }
                        }
                        "error" => {
                            status = SessionStatus::Failed;
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    if session_id.is_empty() {
        return Err(ReconcileError::Parse(
            "omp jsonl missing session id".to_string(),
        ));
    }

    if summary.is_empty() {
        if let Some(ref t) = title {
            summary = t.clone();
        }
    }

    Ok(ReconciledSession {
        session_id,
        agent: CodingAgent::Omp,
        status,
        title,
        summary,
    })
}

pub fn parse_hermes_json(input: &str) -> Result<ReconciledSession, ReconcileError> {
    let value = parse_json(input).map_err(ReconcileError::Parse)?;

    let session_id = value
        .get_str("id")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ReconcileError::Parse("hermes json missing id".to_string()))?
        .to_string();

    let title = value
        .get_str("title")
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let description = value.get_str("description").unwrap_or("");
    let ended = value.get_bool("ended").unwrap_or(false);
    let end_reason = value.get_str("end_reason").unwrap_or("");

    let (status, summary) = if let Some(prompt) = description.strip_prefix(HERMES_NEEDS_INPUT_PREFIX)
    {
        (SessionStatus::NeedsInput, prompt.trim().to_string())
    } else if ended {
        let lower_reason = end_reason.to_ascii_lowercase();
        let st = if lower_reason.contains("fail") || lower_reason.contains("error") {
            SessionStatus::Failed
        } else {
            SessionStatus::Completed
        };
        (st, description.to_string())
    } else {
        (SessionStatus::Running, description.to_string())
    };

    Ok(ReconciledSession {
        session_id,
        agent: CodingAgent::Hermes,
        status,
        title,
        summary,
    })
}

fn non_empty_lines(input: &str) -> impl Iterator<Item = &str> {
    input.lines().map(str::trim).filter(|l| !l.is_empty())
}

fn extract_text_content(content: Option<&JsonValue>) -> Option<String> {
    let value = content?;
    if let Some(s) = value.as_str() {
        return Some(s.to_string());
    }
    if let Some(items) = value.as_array() {
        let mut texts = Vec::new();
        for item in items {
            if let Some(text) = item.get_str("text") {
                if !text.is_empty() {
                    texts.push(text);
                }
            }
        }
        if !texts.is_empty() {
            return Some(texts.join(" "));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn fixture_path(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/petdex-desktop-native/src/test-fixtures/session-reconcile/v1")
            .join(name)
    }

    #[test]
    fn reconciles_real_claude_jsonl_fixture() {
        let session = reconcile_file(CodingAgent::ClaudeCode, &fixture_path("claude.jsonl"))
            .expect("parse claude fixture");
        assert_eq!(session.agent, CodingAgent::ClaudeCode);
        assert_eq!(session.session_id, "claude-primary");
        assert_eq!(session.status, SessionStatus::Completed);
        assert_eq!(session.summary, "Claude review complete");
    }

    #[test]
    fn reconciles_real_gemini_jsonl_fixture() {
        let session = reconcile_file(CodingAgent::Gemini, &fixture_path("gemini.jsonl"))
            .expect("parse gemini fixture");
        assert_eq!(session.agent, CodingAgent::Gemini);
        assert_eq!(session.session_id, "gemini-child");
        assert_eq!(session.title.as_deref(), Some("Gemini authoritative title"));
        assert_eq!(session.status, SessionStatus::Completed);
        assert_eq!(session.summary, "Gemini research complete");
    }

    #[test]
    fn reconciles_real_omp_jsonl_fixture() {
        let session = reconcile_file(CodingAgent::Omp, &fixture_path("omp.jsonl"))
            .expect("parse omp fixture");
        assert_eq!(session.agent, CodingAgent::Omp);
        assert_eq!(session.session_id, "omp-child-source-id");
        assert_eq!(session.title.as_deref(), Some("OMP authoritative title"));
        assert_eq!(session.status, SessionStatus::Completed);
        assert_eq!(session.summary, "OMP review complete");
    }

    #[test]
    fn reconciles_real_hermes_completed_fixture() {
        let session = reconcile_file(CodingAgent::Hermes, &fixture_path("hermes.json"))
            .expect("parse hermes fixture");
        assert_eq!(session.agent, CodingAgent::Hermes);
        assert_eq!(session.session_id, "hermes-child");
        assert_eq!(session.title.as_deref(), Some("Hermes authoritative title"));
        assert_eq!(session.status, SessionStatus::Completed);
        assert_eq!(session.summary, "Hermes review complete");
    }

    #[test]
    fn reconciles_real_hermes_waiting_fixture() {
        let session = reconcile_file(CodingAgent::Hermes, &fixture_path("hermes-waiting.json"))
            .expect("parse hermes-waiting fixture");
        assert_eq!(session.agent, CodingAgent::Hermes);
        assert_eq!(session.session_id, "hermes-parent");
        assert_eq!(session.title.as_deref(), Some("Hermes input title"));
        assert_eq!(session.status, SessionStatus::NeedsInput);
        assert_eq!(session.summary, "Choose a deployment target");

        let event = session.into_agent_event();
        assert_eq!(event.status, SessionStatus::NeedsInput);
        assert_eq!(event.summary, "Choose a deployment target");
    }

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(label: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            use std::time::UNIX_EPOCH;
            static COUNTER: AtomicU64 = AtomicU64::new(0);

            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "petdex-reconcile-{label}-{}-{nonce}-{seq}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn reconcile_local_sessions_fails_closed_on_missing_dirs() {
        let temp = TempDir::new("missing");
        let events = reconcile_local_sessions(temp.path());
        assert!(events.is_empty());

        let nonexistent = temp.path().join("does-not-exist");
        assert!(reconcile_local_sessions(&nonexistent).is_empty());
    }

    #[test]
    fn reconcile_local_sessions_picks_most_recent_and_filters_idle_and_corrupt() {
        let temp = TempDir::new("multi-agent");

        let claude_proj = temp.path().join(".claude").join("projects").join("proj-a");
        fs::create_dir_all(&claude_proj).expect("create claude dir");
        let older_claude = claude_proj.join("older.jsonl");
        fs::write(
            &older_claude,
            r#"{"sessionId":"claude-old","type":"user","message":{"role":"user","content":"Old task"}}"#,
        )
        .expect("write older claude");
        std::thread::sleep(std::time::Duration::from_millis(25));
        let newer_claude = claude_proj.join("newer.jsonl");
        fs::write(
            &newer_claude,
            r#"{"sessionId":"claude-new","type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":"Finished task"}}"#,
        )
        .expect("write newer claude");

        let gemini_dir = temp.path().join(".gemini").join("tmp").join("hash1");
        fs::create_dir_all(&gemini_dir).expect("create gemini dir");
        fs::write(
            gemini_dir.join("session.jsonl"),
            r#"{"sessionId":"gemini-1","summary":"Gemini title"}
{"type":"user","content":"Investigating issue"}"#,
        )
        .expect("write gemini");

        let omp_dir = temp.path().join(".omp").join("sessions");
        fs::create_dir_all(&omp_dir).expect("create omp dir");
        fs::write(
            omp_dir.join("idle.jsonl"),
            r#"{"type":"session","id":"omp-idle"}"#,
        )
        .expect("write idle omp");

        let hermes_dir = temp.path().join(".hermes").join("sessions");
        fs::create_dir_all(&hermes_dir).expect("create hermes dir");
        fs::write(hermes_dir.join("broken.json"), "{ not valid json")
            .expect("write broken hermes");

        let events = reconcile_local_sessions(temp.path());
        assert_eq!(events.len(), 2);

        let claude_ev = events
            .iter()
            .find(|e| e.agent == CodingAgent::ClaudeCode)
            .expect("claude event");
        assert_eq!(claude_ev.session_id, "claude-new");
        assert_eq!(claude_ev.status, SessionStatus::Completed);
        assert_eq!(claude_ev.summary, "Finished task");

        let gemini_ev = events
            .iter()
            .find(|e| e.agent == CodingAgent::Gemini)
            .expect("gemini event");
        assert_eq!(gemini_ev.session_id, "gemini-1");
        assert_eq!(gemini_ev.status, SessionStatus::Running);
        assert_eq!(gemini_ev.summary, "Investigating issue");
    }

    #[test]
    fn reconcile_local_sessions_enforces_bounded_depth() {
        let temp = TempDir::new("bounded-depth");
        let mut deep = temp.path().join(".claude").join("projects");
        for i in 0..=(MAX_SCAN_DEPTH + 2) {
            deep = deep.join(format!("d{i}"));
        }
        fs::create_dir_all(&deep).expect("create deep dir");
        fs::write(
            deep.join("too-deep.jsonl"),
            r#"{"sessionId":"too-deep","type":"user","message":{"role":"user","content":"Should not be scanned"}}"#,
        )
        .expect("write deep session");

        let events = reconcile_local_sessions(temp.path());
        assert!(events.is_empty());
    }
}
