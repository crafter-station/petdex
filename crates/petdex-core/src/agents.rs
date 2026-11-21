#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum CodingAgent {
    ClaudeCode = 0,
    Codex = 1,
    Gemini = 2,
    OpenCode = 3,
    Qoder = 4,
    KimiCode = 5,
    CodeBuddy = 6,
    Omp = 7,
    Hermes = 8,
    Dsh = 9,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentSpec {
    pub agent: CodingAgent,
    pub slug: &'static str,
    pub display_name: &'static str,
    pub default_config_rel_path: &'static str,
    pub supports_durable_recovery: bool,
}

pub trait AgentAdapter: Send + Sync {
    fn spec(&self) -> AgentSpec;

    fn agent(&self) -> CodingAgent {
        self.spec().agent
    }

    fn slug(&self) -> &'static str {
        self.spec().slug
    }

    fn display_name(&self) -> &'static str {
        self.spec().display_name
    }

    fn default_config_rel_path(&self) -> &'static str {
        self.spec().default_config_rel_path
    }

    fn supports_durable_recovery(&self) -> bool {
        self.spec().supports_durable_recovery
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StaticAgentAdapter {
    agent: CodingAgent,
}

impl StaticAgentAdapter {
    pub const fn new(agent: CodingAgent) -> Self {
        Self { agent }
    }
}

impl AgentAdapter for StaticAgentAdapter {
    fn spec(&self) -> AgentSpec {
        self.agent.spec()
    }
}

impl CodingAgent {
    pub const COUNT: usize = 10;

    pub const ALL: [CodingAgent; Self::COUNT] = [
        CodingAgent::ClaudeCode,
        CodingAgent::Codex,
        CodingAgent::Gemini,
        CodingAgent::OpenCode,
        CodingAgent::Qoder,
        CodingAgent::KimiCode,
        CodingAgent::CodeBuddy,
        CodingAgent::Omp,
        CodingAgent::Hermes,
        CodingAgent::Dsh,
    ];

    pub const fn spec(self) -> AgentSpec {
        match self {
            CodingAgent::ClaudeCode => AgentSpec {
                agent: CodingAgent::ClaudeCode,
                slug: "claude-code",
                display_name: "Claude Code",
                default_config_rel_path: ".claude/settings.json",
                supports_durable_recovery: true,
            },
            CodingAgent::Codex => AgentSpec {
                agent: CodingAgent::Codex,
                slug: "codex",
                display_name: "Codex",
                default_config_rel_path: ".codex/hooks.json",
                supports_durable_recovery: true,
            },
            CodingAgent::Gemini => AgentSpec {
                agent: CodingAgent::Gemini,
                slug: "gemini",
                display_name: "Gemini CLI",
                default_config_rel_path: ".gemini/settings.json",
                supports_durable_recovery: true,
            },
            CodingAgent::OpenCode => AgentSpec {
                agent: CodingAgent::OpenCode,
                slug: "opencode",
                display_name: "opencode",
                default_config_rel_path: ".config/opencode/plugins/petdex.js",
                supports_durable_recovery: false,
            },
            CodingAgent::Qoder => AgentSpec {
                agent: CodingAgent::Qoder,
                slug: "qoder",
                display_name: "Qoder",
                default_config_rel_path: ".qoder/settings.json",
                supports_durable_recovery: false,
            },
            CodingAgent::KimiCode => AgentSpec {
                agent: CodingAgent::KimiCode,
                slug: "kimi-code",
                display_name: "Kimi Code",
                default_config_rel_path: ".kimi/config.toml",
                supports_durable_recovery: false,
            },
            CodingAgent::CodeBuddy => AgentSpec {
                agent: CodingAgent::CodeBuddy,
                slug: "codebuddy",
                display_name: "CodeBuddy",
                default_config_rel_path: ".codebuddy/settings.json",
                supports_durable_recovery: false,
            },
            CodingAgent::Omp => AgentSpec {
                agent: CodingAgent::Omp,
                slug: "omp",
                display_name: "OMP",
                default_config_rel_path: ".omp/agent/extensions/petdex.ts",
                supports_durable_recovery: true,
            },
            CodingAgent::Hermes => AgentSpec {
                agent: CodingAgent::Hermes,
                slug: "hermes",
                display_name: "Hermes",
                default_config_rel_path: ".hermes/config.yaml",
                supports_durable_recovery: true,
            },
            CodingAgent::Dsh => AgentSpec {
                agent: CodingAgent::Dsh,
                slug: "dsh",
                display_name: "DeepSeek Harness",
                default_config_rel_path: "Library/Application Support/DSH",
                supports_durable_recovery: false,
            },
        }
    }

    pub const fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(CodingAgent::ClaudeCode),
            1 => Some(CodingAgent::Codex),
            2 => Some(CodingAgent::Gemini),
            3 => Some(CodingAgent::OpenCode),
            4 => Some(CodingAgent::Qoder),
            5 => Some(CodingAgent::KimiCode),
            6 => Some(CodingAgent::CodeBuddy),
            7 => Some(CodingAgent::Omp),
            8 => Some(CodingAgent::Hermes),
            9 => Some(CodingAgent::Dsh),
            _ => None,
        }
    }

    pub fn from_slug(slug: &str) -> Option<Self> {
        match slug {
            "claude-code" => Some(CodingAgent::ClaudeCode),
            "codex" => Some(CodingAgent::Codex),
            "gemini" => Some(CodingAgent::Gemini),
            "opencode" => Some(CodingAgent::OpenCode),
            "qoder" => Some(CodingAgent::Qoder),
            "kimi-code" => Some(CodingAgent::KimiCode),
            "codebuddy" => Some(CodingAgent::CodeBuddy),
            "omp" => Some(CodingAgent::Omp),
            "hermes" => Some(CodingAgent::Hermes),
            "dsh" => Some(CodingAgent::Dsh),
            _ => None,
        }
    }
}

pub const fn all_specs() -> [AgentSpec; CodingAgent::COUNT] {
    [
        CodingAgent::ClaudeCode.spec(),
        CodingAgent::Codex.spec(),
        CodingAgent::Gemini.spec(),
        CodingAgent::OpenCode.spec(),
        CodingAgent::Qoder.spec(),
        CodingAgent::KimiCode.spec(),
        CodingAgent::CodeBuddy.spec(),
        CodingAgent::Omp.spec(),
        CodingAgent::Hermes.spec(),
        CodingAgent::Dsh.spec(),
    ]
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn registry_covers_all_ten_agents_with_unique_slugs() {
        let specs = all_specs();
        assert_eq!(specs.len(), 10);

        let mut slugs = HashSet::new();
        for (index, spec) in specs.iter().enumerate() {
            assert_eq!(spec.agent as usize, index);
            assert!(slugs.insert(spec.slug));
            assert!(!spec.display_name.is_empty());
            assert!(!spec.default_config_rel_path.is_empty());
            assert_eq!(CodingAgent::from_slug(spec.slug), Some(spec.agent));
        }

        assert_eq!(CodingAgent::from_slug("unknown"), None);
    }

    #[test]
    fn durable_recovery_flags_match_known_stores() {
        assert!(CodingAgent::ClaudeCode.spec().supports_durable_recovery);
        assert!(CodingAgent::Codex.spec().supports_durable_recovery);
        assert!(CodingAgent::Gemini.spec().supports_durable_recovery);
        assert!(CodingAgent::Omp.spec().supports_durable_recovery);
        assert!(CodingAgent::Hermes.spec().supports_durable_recovery);

        assert!(!CodingAgent::OpenCode.spec().supports_durable_recovery);
        assert!(!CodingAgent::Qoder.spec().supports_durable_recovery);
        assert!(!CodingAgent::KimiCode.spec().supports_durable_recovery);
        assert!(!CodingAgent::CodeBuddy.spec().supports_durable_recovery);
        assert!(!CodingAgent::Dsh.spec().supports_durable_recovery);
    }

    #[test]
    fn agent_adapter_trait_object_works() {
        let adapter: Box<dyn AgentAdapter> = Box::new(StaticAgentAdapter::new(CodingAgent::Codex));
        assert_eq!(adapter.agent(), CodingAgent::Codex);
        assert_eq!(adapter.slug(), "codex");
        assert_eq!(adapter.display_name(), "Codex");
        assert_eq!(adapter.default_config_rel_path(), ".codex/hooks.json");
        assert!(adapter.supports_durable_recovery());
    }
}
