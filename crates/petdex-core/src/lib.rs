pub mod agents;
pub mod animation;
pub mod attention;
pub mod ffi;
pub mod hook_installer;
pub mod hook_server;
mod json;
pub mod reconcile;
pub mod runtime_token;

pub use agents::{all_specs, AgentAdapter, AgentSpec, CodingAgent, StaticAgentAdapter};
pub use animation::{state_def, FrameOutput, FrameSpec, PetAnimationEngine, PetState, StateDef};
pub use attention::{
    AgentEvent, AttentionConfig, AttentionCoordinator, BubbleEntry, SessionStatus,
};
pub use hook_installer::{
    connect_agent, connect_agent_in, detect_agent_status, detect_agent_status_in,
    disconnect_agent, disconnect_agent_in, ensure_hook_runner_script, AgentInstallStatus,
};
pub use hook_server::{HookServer, HookServerConfig, DEFAULT_HOOK_PORT, UPDATE_TOKEN_HEADER};
pub use reconcile::{
    parse_claude_jsonl, parse_gemini_jsonl, parse_hermes_json, parse_omp_jsonl, reconcile_file,
    ReconcileError, ReconciledSession,
};
