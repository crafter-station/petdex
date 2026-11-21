use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::agents::CodingAgent;
use crate::hook_server::{DEFAULT_HOOK_PORT, UPDATE_TOKEN_HEADER};
use crate::json::{escape_json_str, parse_json, JsonValue};

const PETDEX_HOOK_MARKER: &str = "petdex-hook";
const CODEX_BLOCK_BEGIN: &str = "# petdex-hook-begin";
const CODEX_BLOCK_END: &str = "# petdex-hook-end";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum AgentInstallStatus {
    NotFound = 0,
    Detected = 1,
    Connected = 2,
}

fn resolve_home_dir() -> io::Result<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME or USERPROFILE not set"))
}

fn hook_runner_path(home: &Path) -> PathBuf {
    home.join(".petdex").join("bin").join("petdex-hook")
}

pub fn ensure_hook_runner_script(home: &Path) -> io::Result<PathBuf> {
    let script_path = hook_runner_path(home);
    if let Some(parent) = script_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let script = format!(
        r#"#!/bin/sh
if [ ! -t 0 ]; then
  cat >/dev/null 2>&1 || true
fi

TOKEN_FILE="${{HOME}}/.petdex/runtime/update-token"
if [ ! -f "$TOKEN_FILE" ]; then
  exit 0
fi

TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE" 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  exit 0
fi

AGENT="${{1:-claude-code}}"
STATUS="${{2:-running}}"
SUMMARY="${{3:-}}"
SESSION_ID="${{4:-${{AGENT}}-default}}"
PORT="${{PETDEX_HOOK_PORT:-{port}}}"

json_escape() {{
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\r' '  '
}}

AGENT_ESC="$(json_escape "$AGENT")"
STATUS_ESC="$(json_escape "$STATUS")"
SUMMARY_ESC="$(json_escape "$SUMMARY")"
SESSION_ESC="$(json_escape "$SESSION_ID")"

PAYLOAD="{{\"session_id\":\"${{SESSION_ESC}}\",\"agent\":\"${{AGENT_ESC}}\",\"status\":\"${{STATUS_ESC}}\",\"summary\":\"${{SUMMARY_ESC}}\"}}"

curl -sS --connect-timeout 1 --max-time 2 \
  -X POST "http://127.0.0.1:${{PORT}}/bubble" \
  -H "Content-Type: application/json" \
  -H "{token_header}: ${{TOKEN}}" \
  --data "$PAYLOAD" \
  >/dev/null 2>&1 || true

exit 0
"#,
        port = DEFAULT_HOOK_PORT,
        token_header = UPDATE_TOKEN_HEADER,
    );

    fs::write(&script_path, script)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755))?;
    }

    Ok(script_path)
}

fn config_root_for(home: &Path, agent: CodingAgent) -> PathBuf {
    match agent {
        CodingAgent::ClaudeCode => home.join(".claude"),
        CodingAgent::Codex => home.join(".codex"),
        CodingAgent::Gemini => home.join(".gemini"),
        CodingAgent::OpenCode => home.join(".config").join("opencode"),
        CodingAgent::Qoder => home.join(".qoder"),
        CodingAgent::KimiCode => home.join(".kimi"),
        CodingAgent::CodeBuddy => home.join(".codebuddy"),
        CodingAgent::Omp => home.join(".omp"),
        CodingAgent::Hermes => home.join(".hermes"),
        CodingAgent::Dsh => home.join("Library").join("Application Support").join("DSH"),
    }
}

fn create_backup_once(path: &Path) -> io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return Ok(());
    };
    let backup_path = path.with_file_name(format!("{file_name}.petdex.bak"));
    if !backup_path.exists() {
        fs::copy(path, backup_path)?;
    }
    Ok(())
}

fn json_contains_marker(value: &JsonValue, marker: &str) -> bool {
    match value {
        JsonValue::String(s) => s.contains(marker),
        JsonValue::Array(items) => items.iter().any(|item| json_contains_marker(item, marker)),
        JsonValue::Object(map) => map.values().any(|v| json_contains_marker(v, marker)),
        _ => false,
    }
}

fn render_json_pretty(value: &JsonValue, indent: usize) -> String {
    let mut out = String::new();
    write_json_pretty(value, indent, &mut out);
    out.push('\n');
    out
}

fn write_json_pretty(value: &JsonValue, indent: usize, out: &mut String) {
    match value {
        JsonValue::Null => out.push_str("null"),
        JsonValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        JsonValue::Number(n) => {
            if n.is_finite() && n.fract() == 0.0 && n.abs() < (i64::MAX as f64) {
                out.push_str(&format!("{}", *n as i64));
            } else {
                out.push_str(&format!("{n}"));
            }
        }
        JsonValue::String(s) => out.push_str(&escape_json_str(s)),
        JsonValue::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push_str("[\n");
            let child_indent = indent + 2;
            for (idx, item) in items.iter().enumerate() {
                for _ in 0..child_indent {
                    out.push(' ');
                }
                write_json_pretty(item, child_indent, out);
                if idx + 1 < items.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            for _ in 0..indent {
                out.push(' ');
            }
            out.push(']');
        }
        JsonValue::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push_str("{\n");
            let child_indent = indent + 2;
            let len = map.len();
            for (idx, (k, v)) in map.iter().enumerate() {
                for _ in 0..child_indent {
                    out.push(' ');
                }
                out.push_str(&escape_json_str(k));
                out.push_str(": ");
                write_json_pretty(v, child_indent, out);
                if idx + 1 < len {
                    out.push(',');
                }
                out.push('\n');
            }
            for _ in 0..indent {
                out.push(' ');
            }
            out.push('}');
        }
    }
}

fn build_json_hook_entry(runner_cmd: &str, agent_slug: &str, status: &str) -> JsonValue {
    let mut hook_obj = BTreeMap::new();
    hook_obj.insert("type".to_string(), JsonValue::String("command".to_string()));
    hook_obj.insert(
        "command".to_string(),
        JsonValue::String(format!("{runner_cmd} {agent_slug} {status}")),
    );

    let mut matcher_obj = BTreeMap::new();
    matcher_obj.insert("matcher".to_string(), JsonValue::String("*".to_string()));
    matcher_obj.insert(
        "hooks".to_string(),
        JsonValue::Array(vec![JsonValue::Object(hook_obj)]),
    );

    JsonValue::Object(matcher_obj)
}

fn connect_json_settings(
    home: &Path,
    settings_path: &Path,
    agent_slug: &str,
    events: &[(&str, &str)],
) -> io::Result<bool> {
    let runner = ensure_hook_runner_script(home)?;
    let runner_str = runner.to_string_lossy().to_string();

    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut root_map = if settings_path.exists() {
        create_backup_once(settings_path)?;
        let content = fs::read_to_string(settings_path)?;
        if content.trim().is_empty() {
            BTreeMap::new()
        } else {
            let parsed = parse_json(&content).map_err(|err| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid JSON in {}: {err}", settings_path.display()),
                )
            })?;
            match parsed {
                JsonValue::Object(map) => map,
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("expected JSON object in {}", settings_path.display()),
                    ))
                }
            }
        }
    } else {
        BTreeMap::new()
    };

    let mut hooks_map = match root_map.remove("hooks") {
        Some(JsonValue::Object(map)) => map,
        Some(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("expected 'hooks' object in {}", settings_path.display()),
            ))
        }
        None => BTreeMap::new(),
    };

    for (event_name, status) in events {
        let mut entries = match hooks_map.remove(*event_name) {
            Some(JsonValue::Array(items)) => items,
            _ => Vec::new(),
        };
        entries.retain(|item| !json_contains_marker(item, PETDEX_HOOK_MARKER));
        entries.push(build_json_hook_entry(&runner_str, agent_slug, status));
        hooks_map.insert((*event_name).to_string(), JsonValue::Array(entries));
    }

    root_map.insert("hooks".to_string(), JsonValue::Object(hooks_map));
    let rendered = render_json_pretty(&JsonValue::Object(root_map), 0);
    fs::write(settings_path, rendered)?;
    Ok(true)
}

fn disconnect_json_settings(settings_path: &Path) -> io::Result<bool> {
    if !settings_path.exists() {
        return Ok(false);
    }

    let content = fs::read_to_string(settings_path)?;
    if !content.contains(PETDEX_HOOK_MARKER) {
        return Ok(false);
    }

    let parsed = parse_json(&content).map_err(|err| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid JSON in {}: {err}", settings_path.display()),
        )
    })?;
    let JsonValue::Object(mut root_map) = parsed else {
        return Ok(false);
    };

    let mut changed = false;
    if let Some(JsonValue::Object(mut hooks_map)) = root_map.remove("hooks") {
        let keys: Vec<String> = hooks_map.keys().cloned().collect();
        for key in keys {
            if let Some(JsonValue::Array(mut items)) = hooks_map.remove(&key) {
                let before = items.len();
                items.retain(|item| !json_contains_marker(item, PETDEX_HOOK_MARKER));
                if items.len() != before {
                    changed = true;
                }
                if !items.is_empty() {
                    hooks_map.insert(key, JsonValue::Array(items));
                }
            }
        }
        if !hooks_map.is_empty() {
            root_map.insert("hooks".to_string(), JsonValue::Object(hooks_map));
        }
    }

    if !changed {
        return Ok(false);
    }

    let rendered = render_json_pretty(&JsonValue::Object(root_map), 0);
    fs::write(settings_path, rendered)?;
    Ok(true)
}

fn strip_codex_managed_block(content: &str) -> (String, bool) {
    let mut out_lines: Vec<&str> = Vec::new();
    let mut in_block = false;
    let mut removed = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == CODEX_BLOCK_BEGIN {
            in_block = true;
            removed = true;
            continue;
        }
        if in_block {
            if trimmed == CODEX_BLOCK_END {
                in_block = false;
            }
            continue;
        }
        out_lines.push(line);
    }

    while out_lines.last().is_some_and(|l| l.trim().is_empty()) {
        out_lines.pop();
    }

    let mut result = out_lines.join("\n");
    if !result.is_empty() {
        result.push('\n');
    }
    (result, removed)
}

fn escape_toml_str(input: &str) -> String {
    input.replace('\\', "\\\\").replace('"', "\\\"")
}

fn connect_codex(home: &Path) -> io::Result<bool> {
    let runner = ensure_hook_runner_script(home)?;
    let config_path = home.join(".codex").join("config.toml");
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let existing = if config_path.exists() {
        create_backup_once(&config_path)?;
        fs::read_to_string(&config_path)?
    } else {
        String::new()
    };

    let (base, _) = strip_codex_managed_block(&existing);
    let escaped_runner = escape_toml_str(&runner.to_string_lossy());
    let block = format!(
        "{CODEX_BLOCK_BEGIN}\nnotify = [\"{escaped_runner}\", \"codex\", \"completed\"]\n{CODEX_BLOCK_END}\n"
    );

    let updated = if base.is_empty() {
        block
    } else {
        format!("{base}\n{block}")
    };

    fs::write(&config_path, updated)?;
    Ok(true)
}

fn disconnect_codex(home: &Path) -> io::Result<bool> {
    let config_path = home.join(".codex").join("config.toml");
    if !config_path.exists() {
        return Ok(false);
    }

    let existing = fs::read_to_string(&config_path)?;
    let (stripped, removed) = strip_codex_managed_block(&existing);
    if !removed {
        return Ok(false);
    }

    fs::write(&config_path, stripped)?;
    Ok(true)
}

fn connect_opencode(home: &Path) -> io::Result<bool> {
    let runner = ensure_hook_runner_script(home)?;
    let plugin_path = home
        .join(".config")
        .join("opencode")
        .join("plugins")
        .join("petdex-hook.js");
    if let Some(parent) = plugin_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let runner_escaped = escape_json_str(&runner.to_string_lossy());
    let plugin = format!(
        r#"import {{ spawn }} from "node:child_process";

const RUNNER = {runner_escaped};

function notify(status, summary = "") {{
  try {{
    const child = spawn(RUNNER, ["opencode", status, summary], {{
      stdio: "ignore",
      detached: true,
    }});
    child.unref();
  }} catch {{
  }}
}}

export const PetdexHookPlugin = async () => ({{
  event: async ({{ event }}) => {{
    if (!event || !event.type) return;
    if (event.type === "session.idle") {{
      notify("completed", "Session completed");
    }} else if (event.type === "session.error") {{
      notify("failed", "Session error");
    }} else if (event.type === "permission.updated") {{
      notify("needs_input", "Waiting for permission");
    }}
  }},
}});
"#
    );

    fs::write(&plugin_path, plugin)?;
    Ok(true)
}

fn disconnect_opencode(home: &Path) -> io::Result<bool> {
    let plugin_path = home
        .join(".config")
        .join("opencode")
        .join("plugins")
        .join("petdex-hook.js");
    if !plugin_path.exists() {
        return Ok(false);
    }
    fs::remove_file(&plugin_path)?;
    Ok(true)
}

fn connect_hermes(home: &Path) -> io::Result<bool> {
    let runner = ensure_hook_runner_script(home)?;
    let hook_path = home.join(".hermes").join("hooks").join("petdex-hook.sh");
    if let Some(parent) = hook_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let runner_str = runner.to_string_lossy();
    let script = format!(
        r#"#!/bin/sh
"{runner_str}" hermes "${{1:-running}}" "${{2:-}}" "${{3:-hermes-default}}" >/dev/null 2>&1 || true
exit 0
"#
    );

    fs::write(&hook_path, script)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook_path, fs::Permissions::from_mode(0o755))?;
    }

    Ok(true)
}

fn disconnect_hermes(home: &Path) -> io::Result<bool> {
    let hook_path = home.join(".hermes").join("hooks").join("petdex-hook.sh");
    if !hook_path.exists() {
        return Ok(false);
    }
    fs::remove_file(&hook_path)?;
    Ok(true)
}

pub fn detect_agent_status_in(home: &Path, agent: CodingAgent) -> AgentInstallStatus {
    match agent {
        CodingAgent::ClaudeCode => {
            let settings = home.join(".claude").join("settings.json");
            if let Ok(content) = fs::read_to_string(&settings) {
                if content.contains(PETDEX_HOOK_MARKER) {
                    return AgentInstallStatus::Connected;
                }
            }
            if config_root_for(home, agent).exists() {
                AgentInstallStatus::Detected
            } else {
                AgentInstallStatus::NotFound
            }
        }
        CodingAgent::Gemini => {
            let settings = home.join(".gemini").join("settings.json");
            if let Ok(content) = fs::read_to_string(&settings) {
                if content.contains(PETDEX_HOOK_MARKER) {
                    return AgentInstallStatus::Connected;
                }
            }
            if config_root_for(home, agent).exists() {
                AgentInstallStatus::Detected
            } else {
                AgentInstallStatus::NotFound
            }
        }
        CodingAgent::Codex => {
            let config = home.join(".codex").join("config.toml");
            if let Ok(content) = fs::read_to_string(&config) {
                if content.contains(CODEX_BLOCK_BEGIN) && content.contains(CODEX_BLOCK_END) {
                    return AgentInstallStatus::Connected;
                }
            }
            if config_root_for(home, agent).exists() {
                AgentInstallStatus::Detected
            } else {
                AgentInstallStatus::NotFound
            }
        }
        CodingAgent::OpenCode => {
            let plugin = home
                .join(".config")
                .join("opencode")
                .join("plugins")
                .join("petdex-hook.js");
            if plugin.exists() {
                AgentInstallStatus::Connected
            } else if config_root_for(home, agent).exists() {
                AgentInstallStatus::Detected
            } else {
                AgentInstallStatus::NotFound
            }
        }
        CodingAgent::Hermes => {
            let hook = home.join(".hermes").join("hooks").join("petdex-hook.sh");
            if hook.exists() {
                AgentInstallStatus::Connected
            } else if config_root_for(home, agent).exists() {
                AgentInstallStatus::Detected
            } else {
                AgentInstallStatus::NotFound
            }
        }
        CodingAgent::Qoder
        | CodingAgent::KimiCode
        | CodingAgent::CodeBuddy
        | CodingAgent::Omp
        | CodingAgent::Dsh => {
            if config_root_for(home, agent).exists() {
                AgentInstallStatus::Detected
            } else {
                AgentInstallStatus::NotFound
            }
        }
    }
}

pub fn connect_agent_in(home: &Path, agent: CodingAgent) -> io::Result<bool> {
    match agent {
        CodingAgent::ClaudeCode => connect_json_settings(
            home,
            &home.join(".claude").join("settings.json"),
            "claude-code",
            &[
                ("UserPromptSubmit", "running"),
                ("Stop", "completed"),
                ("Notification", "needs_input"),
            ],
        ),
        CodingAgent::Gemini => connect_json_settings(
            home,
            &home.join(".gemini").join("settings.json"),
            "gemini",
            &[
                ("BeforeAgent", "running"),
                ("AfterAgent", "completed"),
                ("Notification", "needs_input"),
            ],
        ),
        CodingAgent::Codex => connect_codex(home),
        CodingAgent::OpenCode => connect_opencode(home),
        CodingAgent::Hermes => connect_hermes(home),
        CodingAgent::Qoder
        | CodingAgent::KimiCode
        | CodingAgent::CodeBuddy
        | CodingAgent::Omp
        | CodingAgent::Dsh => Ok(false),
    }
}

pub fn disconnect_agent_in(home: &Path, agent: CodingAgent) -> io::Result<bool> {
    match agent {
        CodingAgent::ClaudeCode => {
            disconnect_json_settings(&home.join(".claude").join("settings.json"))
        }
        CodingAgent::Gemini => {
            disconnect_json_settings(&home.join(".gemini").join("settings.json"))
        }
        CodingAgent::Codex => disconnect_codex(home),
        CodingAgent::OpenCode => disconnect_opencode(home),
        CodingAgent::Hermes => disconnect_hermes(home),
        CodingAgent::Qoder
        | CodingAgent::KimiCode
        | CodingAgent::CodeBuddy
        | CodingAgent::Omp
        | CodingAgent::Dsh => Ok(false),
    }
}

pub fn detect_agent_status(agent: CodingAgent) -> AgentInstallStatus {
    let Ok(home) = resolve_home_dir() else {
        return AgentInstallStatus::NotFound;
    };
    detect_agent_status_in(&home, agent)
}

pub fn connect_agent(agent: CodingAgent) -> io::Result<bool> {
    let home = resolve_home_dir()?;
    connect_agent_in(&home, agent)
}

pub fn disconnect_agent(agent: CodingAgent) -> io::Result<bool> {
    let home = resolve_home_dir()?;
    disconnect_agent_in(&home, agent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempHome {
        path: PathBuf,
    }

    impl TempHome {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let seq = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "petdex-hook-installer-{label}-{}-{nonce}-{seq}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create temp home");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn ensure_hook_runner_script_creates_executable_script() {
        let home = TempHome::new("runner");
        let script_path =
            ensure_hook_runner_script(home.path()).expect("create hook runner script");

        assert_eq!(
            script_path,
            home.path().join(".petdex").join("bin").join("petdex-hook")
        );
        let content = fs::read_to_string(&script_path).expect("read script");
        assert!(content.starts_with("#!/bin/sh\n"));
        assert!(content.contains(".petdex/runtime/update-token"));
        assert!(content.contains("http://127.0.0.1:${PORT}/bubble"));
        assert!(content.contains("x-petdex-update-token"));
        assert!(content.contains("exit 0"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&script_path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o755);
        }
    }

    #[test]
    fn claude_code_lifecycle_preserves_foreign_keys_and_creates_backup() {
        let home = TempHome::new("claude");
        let agent = CodingAgent::ClaudeCode;

        assert_eq!(
            detect_agent_status_in(home.path(), agent),
            AgentInstallStatus::NotFound
        );

        let claude_dir = home.path().join(".claude");
        fs::create_dir_all(&claude_dir).expect("create .claude");
        let settings_path = claude_dir.join("settings.json");
        let original = r#"{
  "theme": "dark",
  "maxTokens": 4096,
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/user-custom-hook"
          }
        ]
      }
    ]
  }
}
"#;
        fs::write(&settings_path, original).expect("write original settings");

        assert_eq!(
            detect_agent_status_in(home.path(), agent),
            AgentInstallStatus::Detected
        );

        assert!(connect_agent_in(home.path(), agent).expect("connect claude"));
        assert_eq!(
            detect_agent_status_in(home.path(), agent),
            AgentInstallStatus::Connected
        );

        let backup_path = claude_dir.join("settings.json.petdex.bak");
        assert!(backup_path.exists());
        assert_eq!(
            fs::read_to_string(&backup_path).expect("read backup"),
            original
        );

        let connected_json =
            parse_json(&fs::read_to_string(&settings_path).expect("read connected"))
                .expect("valid connected json");
        assert_eq!(connected_json.get_str("theme"), Some("dark"));
        let stop_hooks = connected_json
            .get("hooks")
            .and_then(|h| h.get("Stop"))
            .and_then(|s| s.as_array())
            .expect("Stop hooks array");
        assert_eq!(stop_hooks.len(), 2);

        assert!(connect_agent_in(home.path(), agent).expect("idempotent connect"));
        let after_second_connect =
            parse_json(&fs::read_to_string(&settings_path).expect("read second connect"))
                .expect("valid json");
        let stop_hooks_again = after_second_connect
            .get("hooks")
            .and_then(|h| h.get("Stop"))
            .and_then(|s| s.as_array())
            .expect("Stop hooks array");
        assert_eq!(stop_hooks_again.len(), 2);

        assert!(disconnect_agent_in(home.path(), agent).expect("disconnect claude"));
        assert_eq!(
            detect_agent_status_in(home.path(), agent),
            AgentInstallStatus::Detected
        );

        let disconnected_str = fs::read_to_string(&settings_path).expect("read disconnected");
        assert!(!disconnected_str.contains(PETDEX_HOOK_MARKER));
        assert!(disconnected_str.contains("/usr/local/bin/user-custom-hook"));
        let disconnected_json = parse_json(&disconnected_str).expect("valid disconnected json");
        assert_eq!(disconnected_json.get_str("theme"), Some("dark"));
    }

    #[test]
    fn gemini_lifecycle_preserves_foreign_keys_and_creates_backup() {
        let home = TempHome::new("gemini");
        let agent = CodingAgent::Gemini;

        assert_eq!(
            detect_agent_status_in(home.path(), agent),
            AgentInstallStatus::NotFound
        );

        let gemini_dir = home.path().join(".gemini");
        fs::create_dir_all(&gemini_dir).expect("create .gemini");
        let settings_path = gemini_dir.join("settings.json");
        let original = "{\n  \"model\": \"gemini-2.5-pro\"\n}\n";
        fs::write(&settings_path, original).expect("write original gemini settings");

        assert_eq!(
            detect_agent_status_in(home.path(), agent),
            AgentInstallStatus::Detected
        );

        assert!(connect_agent_in(home.path(), agent).expect("connect gemini"));
        assert_eq!(
            detect_agent_status_in(home.path(), agent),
            AgentInstallStatus::Connected
        );
        assert!(gemini_dir.join("settings.json.petdex.bak").exists());

        assert!(disconnect_agent_in(home.path(), agent).expect("disconnect gemini"));
        assert_eq!(
            detect_agent_status_in(home.path(), agent),
            AgentInstallStatus::Detected
        );

        let after = fs::read_to_string(&settings_path).expect("read after");
        assert!(!after.contains(PETDEX_HOOK_MARKER));
        let parsed = parse_json(&after).expect("valid json");
        assert_eq!(parsed.get_str("model"), Some("gemini-2.5-pro"));
        assert!(parsed.get("hooks").is_none());
    }

    #[test]
    fn codex_lifecycle_preserves_foreign_toml_and_creates_backup() {
        let home = TempHome::new("codex");
        let agent = CodingAgent::Codex;

        assert_eq!(
            detect_agent_status_in(home.path(), agent),
            AgentInstallStatus::NotFound
        );

        let codex_dir = home.path().join(".codex");
        fs::create_dir_all(&codex_dir).expect("create .codex");
        let config_path = codex_dir.join("config.toml");
        let original = "model = \"o3\"\napproval_policy = \"on-request\"\n";
        fs::write(&config_path, original).expect("write config.toml");

        assert_eq!(
            detect_agent_status_in(home.path(), agent),
            AgentInstallStatus::Detected
        );

        assert!(connect_agent_in(home.path(), agent).expect("connect codex"));
        assert_eq!(
            detect_agent_status_in(home.path(), agent),
            AgentInstallStatus::Connected
        );

        let backup_path = codex_dir.join("config.toml.petdex.bak");
        assert!(backup_path.exists());
        assert_eq!(
            fs::read_to_string(&backup_path).expect("read backup"),
            original
        );

        let connected = fs::read_to_string(&config_path).expect("read connected toml");
        assert!(connected.contains("model = \"o3\""));
        assert!(connected.contains("approval_policy = \"on-request\""));
        assert!(connected.contains(CODEX_BLOCK_BEGIN));
        assert!(connected.contains(CODEX_BLOCK_END));

        assert!(disconnect_agent_in(home.path(), agent).expect("disconnect codex"));
        assert_eq!(
            detect_agent_status_in(home.path(), agent),
            AgentInstallStatus::Detected
        );

        let disconnected = fs::read_to_string(&config_path).expect("read disconnected toml");
        assert_eq!(disconnected, original);
        assert!(!disconnected.contains(CODEX_BLOCK_BEGIN));
    }

    #[test]
    fn opencode_and_hermes_dedicated_file_lifecycles() {
        let home = TempHome::new("opencode-hermes");

        assert_eq!(
            detect_agent_status_in(home.path(), CodingAgent::OpenCode),
            AgentInstallStatus::NotFound
        );
        let oc_root = home.path().join(".config").join("opencode");
        fs::create_dir_all(&oc_root).expect("create opencode root");
        fs::write(oc_root.join("opencode.json"), "{\"theme\":\"tokyo\"}")
            .expect("write foreign opencode config");
        assert_eq!(
            detect_agent_status_in(home.path(), CodingAgent::OpenCode),
            AgentInstallStatus::Detected
        );

        assert!(connect_agent_in(home.path(), CodingAgent::OpenCode).expect("connect opencode"));
        assert_eq!(
            detect_agent_status_in(home.path(), CodingAgent::OpenCode),
            AgentInstallStatus::Connected
        );
        assert!(oc_root.join("plugins").join("petdex-hook.js").exists());

        assert!(
            disconnect_agent_in(home.path(), CodingAgent::OpenCode).expect("disconnect opencode")
        );
        assert_eq!(
            detect_agent_status_in(home.path(), CodingAgent::OpenCode),
            AgentInstallStatus::Detected
        );
        assert!(!oc_root.join("plugins").join("petdex-hook.js").exists());
        assert_eq!(
            fs::read_to_string(oc_root.join("opencode.json")).expect("read foreign"),
            "{\"theme\":\"tokyo\"}"
        );

        assert_eq!(
            detect_agent_status_in(home.path(), CodingAgent::Hermes),
            AgentInstallStatus::NotFound
        );
        let hermes_root = home.path().join(".hermes");
        fs::create_dir_all(&hermes_root).expect("create hermes root");
        assert_eq!(
            detect_agent_status_in(home.path(), CodingAgent::Hermes),
            AgentInstallStatus::Detected
        );

        assert!(connect_agent_in(home.path(), CodingAgent::Hermes).expect("connect hermes"));
        assert_eq!(
            detect_agent_status_in(home.path(), CodingAgent::Hermes),
            AgentInstallStatus::Connected
        );
        assert!(hermes_root.join("hooks").join("petdex-hook.sh").exists());

        assert!(disconnect_agent_in(home.path(), CodingAgent::Hermes).expect("disconnect hermes"));
        assert_eq!(
            detect_agent_status_in(home.path(), CodingAgent::Hermes),
            AgentInstallStatus::Detected
        );
    }

    #[test]
    fn other_agents_detect_default_config_roots() {
        let home = TempHome::new("others");
        let cases = [
            (CodingAgent::Qoder, PathBuf::from(".qoder")),
            (CodingAgent::KimiCode, PathBuf::from(".kimi")),
            (CodingAgent::CodeBuddy, PathBuf::from(".codebuddy")),
            (CodingAgent::Omp, PathBuf::from(".omp")),
            (
                CodingAgent::Dsh,
                PathBuf::from("Library").join("Application Support").join("DSH"),
            ),
        ];

        for (agent, rel_root) in cases {
            assert_eq!(
                detect_agent_status_in(home.path(), agent),
                AgentInstallStatus::NotFound
            );
            fs::create_dir_all(home.path().join(&rel_root)).expect("create agent root");
            assert_eq!(
                detect_agent_status_in(home.path(), agent),
                AgentInstallStatus::Detected
            );
            assert!(!connect_agent_in(home.path(), agent).expect("unsupported connect"));
            assert!(!disconnect_agent_in(home.path(), agent).expect("unsupported disconnect"));
        }
    }
}
