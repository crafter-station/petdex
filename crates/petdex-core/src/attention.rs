use std::collections::HashMap;

use crate::agents::CodingAgent;
use crate::animation::PetState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum SessionStatus {
    Idle = 0,
    Completed = 1,
    Running = 2,
    Failed = 3,
    NeedsInput = 4,
}

impl SessionStatus {
    pub const fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(SessionStatus::Idle),
            1 => Some(SessionStatus::Completed),
            2 => Some(SessionStatus::Running),
            3 => Some(SessionStatus::Failed),
            4 => Some(SessionStatus::NeedsInput),
            _ => None,
        }
    }

    pub fn from_str_name(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "idle" => Some(SessionStatus::Idle),
            "completed" | "complete" | "done" | "review" => Some(SessionStatus::Completed),
            "running" | "working" | "busy" => Some(SessionStatus::Running),
            "failed" | "fail" | "error" => Some(SessionStatus::Failed),
            "needs_input" | "needs-input" | "waiting" | "input" => Some(SessionStatus::NeedsInput),
            _ => None,
        }
    }

    pub const fn slug(self) -> &'static str {
        match self {
            SessionStatus::Idle => "idle",
            SessionStatus::Completed => "completed",
            SessionStatus::Running => "running",
            SessionStatus::Failed => "failed",
            SessionStatus::NeedsInput => "needs-input",
        }
    }

    pub const fn priority(self) -> u8 {
        match self {
            SessionStatus::NeedsInput => 4,
            SessionStatus::Failed => 3,
            SessionStatus::Running => 2,
            SessionStatus::Completed => 1,
            SessionStatus::Idle => 0,
        }
    }

    pub const fn pet_state(self) -> PetState {
        match self {
            SessionStatus::NeedsInput => PetState::Waiting,
            SessionStatus::Failed => PetState::Failed,
            SessionStatus::Running => PetState::Running,
            SessionStatus::Completed => PetState::Review,
            SessionStatus::Idle => PetState::Idle,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentEvent {
    pub session_id: String,
    pub agent: CodingAgent,
    pub status: SessionStatus,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BubbleEntry {
    pub session_id: String,
    pub agent: CodingAgent,
    pub status: SessionStatus,
    pub summary: String,
    pub updated_at_ms: u64,
    pub expires_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttentionConfig {
    pub completed_dwell_ms: u64,
    pub failed_dwell_ms: u64,
    pub running_stale_ms: u64,
    pub max_bubbles: usize,
}

impl Default for AttentionConfig {
    fn default() -> Self {
        Self {
            completed_dwell_ms: 8_000,
            failed_dwell_ms: 12_000,
            running_stale_ms: 15 * 60 * 1_000,
            max_bubbles: 12,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AttentionCoordinator {
    config: AttentionConfig,
    sessions: HashMap<String, BubbleEntry>,
}

impl Default for AttentionCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl AttentionCoordinator {
    pub fn new() -> Self {
        Self::with_config(AttentionConfig::default())
    }

    pub fn with_config(config: AttentionConfig) -> Self {
        Self {
            config,
            sessions: HashMap::new(),
        }
    }

    pub fn ingest(&mut self, event: AgentEvent, now_ms: u64) {
        self.prune(now_ms);

        if event.status == SessionStatus::Idle {
            self.sessions.remove(&event.session_id);
            return;
        }

        let expires_at_ms = match event.status {
            SessionStatus::NeedsInput => None,
            SessionStatus::Failed => Some(now_ms.saturating_add(self.config.failed_dwell_ms)),
            SessionStatus::Running => Some(now_ms.saturating_add(self.config.running_stale_ms)),
            SessionStatus::Completed => Some(now_ms.saturating_add(self.config.completed_dwell_ms)),
            SessionStatus::Idle => None,
        };

        let entry = BubbleEntry {
            session_id: event.session_id.clone(),
            agent: event.agent,
            status: event.status,
            summary: event.summary,
            updated_at_ms: now_ms,
            expires_at_ms,
        };

        self.sessions.insert(event.session_id, entry);
    }

    pub fn dismiss(&mut self, session_id: &str) -> bool {
        self.sessions.remove(session_id).is_some()
    }

    pub fn prune(&mut self, now_ms: u64) {
        self.sessions.retain(|_, entry| !is_expired(entry, now_ms));
    }

    pub fn active_bubbles(&self, now_ms: u64) -> Vec<BubbleEntry> {
        let mut live: Vec<BubbleEntry> = self
            .sessions
            .values()
            .filter(|entry| !is_expired(entry, now_ms))
            .cloned()
            .collect();

        live.sort_by(|a, b| {
            b.status
                .priority()
                .cmp(&a.status.priority())
                .then_with(|| b.updated_at_ms.cmp(&a.updated_at_ms))
                .then_with(|| a.session_id.cmp(&b.session_id))
        });

        live.truncate(self.config.max_bubbles);
        live
    }

    pub fn active_state(&self, now_ms: u64) -> PetState {
        self.sessions
            .values()
            .filter(|entry| !is_expired(entry, now_ms))
            .map(|entry| entry.status)
            .max_by_key(|status| status.priority())
            .map(SessionStatus::pet_state)
            .unwrap_or(PetState::Idle)
    }
}

fn is_expired(entry: &BubbleEntry, now_ms: u64) -> bool {
    match entry.expires_at_ms {
        Some(expires_at) => now_ms >= expires_at,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: &str, agent: CodingAgent, status: SessionStatus, summary: &str) -> AgentEvent {
        AgentEvent {
            session_id: id.to_string(),
            agent,
            status,
            summary: summary.to_string(),
        }
    }

    #[test]
    fn priority_order_is_needs_input_failed_running_completed_idle() {
        let mut coord = AttentionCoordinator::new();
        assert_eq!(coord.active_state(0), PetState::Idle);

        coord.ingest(event("s1", CodingAgent::Codex, SessionStatus::Completed, "done"), 100);
        assert_eq!(coord.active_state(100), PetState::Review);

        coord.ingest(event("s2", CodingAgent::ClaudeCode, SessionStatus::Running, "working"), 200);
        assert_eq!(coord.active_state(200), PetState::Running);

        coord.ingest(event("s3", CodingAgent::Gemini, SessionStatus::Failed, "build failed"), 300);
        assert_eq!(coord.active_state(300), PetState::Failed);

        coord.ingest(event("s4", CodingAgent::OpenCode, SessionStatus::NeedsInput, "approve edit"), 400);
        assert_eq!(coord.active_state(400), PetState::Waiting);

        coord.dismiss("s4");
        assert_eq!(coord.active_state(400), PetState::Failed);

        coord.dismiss("s3");
        assert_eq!(coord.active_state(400), PetState::Running);

        coord.dismiss("s2");
        assert_eq!(coord.active_state(400), PetState::Review);

        coord.dismiss("s1");
        assert_eq!(coord.active_state(400), PetState::Idle);
    }

    #[test]
    fn dwell_expiry_drops_completed_and_failed_bubbles() {
        let mut coord = AttentionCoordinator::with_config(AttentionConfig {
            completed_dwell_ms: 5_000,
            failed_dwell_ms: 9_000,
            running_stale_ms: 60_000,
            max_bubbles: 8,
        });

        coord.ingest(event("done", CodingAgent::Codex, SessionStatus::Completed, "tests pass"), 1_000);
        coord.ingest(event("fail", CodingAgent::ClaudeCode, SessionStatus::Failed, "compile error"), 1_000);

        assert_eq!(coord.active_state(5_999), PetState::Failed);
        assert_eq!(coord.active_bubbles(5_999).len(), 2);

        assert_eq!(coord.active_bubbles(6_000).len(), 1);
        assert_eq!(coord.active_bubbles(6_000)[0].session_id, "fail");
        assert_eq!(coord.active_state(6_000), PetState::Failed);

        assert_eq!(coord.active_bubbles(9_999).len(), 1);
        assert_eq!(coord.active_bubbles(10_000).len(), 0);
        assert_eq!(coord.active_state(10_000), PetState::Idle);
    }

    #[test]
    fn bubble_stacking_orders_by_priority_then_recency_and_respects_cap() {
        let mut coord = AttentionCoordinator::with_config(AttentionConfig {
            max_bubbles: 3,
            ..AttentionConfig::default()
        });

        coord.ingest(event("run-old", CodingAgent::Codex, SessionStatus::Running, "a"), 100);
        coord.ingest(event("run-new", CodingAgent::ClaudeCode, SessionStatus::Running, "b"), 200);
        coord.ingest(event("need-1", CodingAgent::Gemini, SessionStatus::NeedsInput, "c"), 150);
        coord.ingest(event("fail-1", CodingAgent::Omp, SessionStatus::Failed, "d"), 180);

        let bubbles = coord.active_bubbles(250);
        assert_eq!(bubbles.len(), 3);
        assert_eq!(bubbles[0].session_id, "need-1");
        assert_eq!(bubbles[1].session_id, "fail-1");
        assert_eq!(bubbles[2].session_id, "run-new");
    }

    #[test]
    fn idle_event_clears_existing_session_and_updates_replace_in_place() {
        let mut coord = AttentionCoordinator::new();
        coord.ingest(event("s1", CodingAgent::Hermes, SessionStatus::Running, "step 1"), 100);
        coord.ingest(event("s1", CodingAgent::Hermes, SessionStatus::NeedsInput, "confirm"), 200);

        let bubbles = coord.active_bubbles(200);
        assert_eq!(bubbles.len(), 1);
        assert_eq!(bubbles[0].status, SessionStatus::NeedsInput);
        assert_eq!(bubbles[0].summary, "confirm");

        coord.ingest(event("s1", CodingAgent::Hermes, SessionStatus::Idle, ""), 300);
        assert!(coord.active_bubbles(300).is_empty());
        assert_eq!(coord.active_state(300), PetState::Idle);
    }
}
