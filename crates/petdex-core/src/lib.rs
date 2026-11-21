pub mod agents;
pub mod animation;
pub mod attention;
pub mod ffi;

pub use agents::{all_specs, AgentAdapter, AgentSpec, CodingAgent, StaticAgentAdapter};
pub use animation::{state_def, FrameOutput, FrameSpec, PetAnimationEngine, PetState, StateDef};
pub use attention::{
    AgentEvent, AttentionConfig, AttentionCoordinator, BubbleEntry, SessionStatus,
};
