use std::ffi::{c_char, CStr};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::agents::CodingAgent;
use crate::animation::{FrameOutput, PetAnimationEngine, PetState};
use crate::attention::{AgentEvent, AttentionCoordinator, SessionStatus};
use crate::hook_installer::{
    connect_agent, detect_agent_status, disconnect_agent, AgentInstallStatus,
};
use crate::hook_server::{HookServer, HookServerConfig};
use crate::json::escape_json_str;

const CORE_VERSION_CSTR: &[u8] = concat!(env!("CARGO_PKG_VERSION"), "\0").as_bytes();

pub struct PetdexEngine {
    inner: PetAnimationEngine,
    attention: Arc<Mutex<AttentionCoordinator>>,
    hook_server: Option<HookServer>,
    last_hook_state: Option<PetState>,
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct PetdexFrame {
    pub state: u8,
    pub row: u32,
    pub col: u32,
    pub frame_index: u32,
    pub frame_dur_ms: u32,
}

impl From<FrameOutput> for PetdexFrame {
    fn from(value: FrameOutput) -> Self {
        Self {
            state: value.state as u8,
            row: value.row as u32,
            col: value.col as u32,
            frame_index: value.frame_index,
            frame_dur_ms: value.frame_dur_ms,
        }
    }
}

#[no_mangle]
pub extern "C" fn petdex_core_version() -> *const c_char {
    CORE_VERSION_CSTR.as_ptr() as *const c_char
}

#[no_mangle]
pub extern "C" fn petdex_engine_new() -> *mut PetdexEngine {
    Box::into_raw(Box::new(PetdexEngine {
        inner: PetAnimationEngine::new(),
        attention: Arc::new(Mutex::new(AttentionCoordinator::new())),
        hook_server: None,
        last_hook_state: None,
    }))
}

#[no_mangle]
pub unsafe extern "C" fn petdex_engine_free(engine: *mut PetdexEngine) {
    if !engine.is_null() {
        drop(Box::from_raw(engine));
    }
}

#[no_mangle]
pub unsafe extern "C" fn petdex_engine_set_state(engine: *mut PetdexEngine, state: u8) -> bool {
    let Some(engine) = engine.as_mut() else {
        return false;
    };
    let Some(pet_state) = PetState::from_u8(state) else {
        return false;
    };
    engine.inner.set_state(pet_state);
    true
}

#[no_mangle]
pub unsafe extern "C" fn petdex_engine_ingest_status(
    engine: *mut PetdexEngine,
    session_id: *const c_char,
    agent: u8,
    status: u8,
    summary: *const c_char,
    now_ms: u64,
) -> bool {
    let Some(engine) = engine.as_mut() else {
        return false;
    };
    if session_id.is_null() {
        return false;
    }
    let Some(agent) = CodingAgent::from_u8(agent) else {
        return false;
    };
    let Some(status) = SessionStatus::from_u8(status) else {
        return false;
    };
    let Ok(session_id_str) = CStr::from_ptr(session_id).to_str() else {
        return false;
    };
    let summary_str = if summary.is_null() {
        ""
    } else {
        match CStr::from_ptr(summary).to_str() {
            Ok(s) => s,
            Err(_) => return false,
        }
    };

    let next_state = {
        let mut guard = engine.attention.lock().unwrap_or_else(|e| e.into_inner());
        guard.ingest(
            AgentEvent {
                session_id: session_id_str.to_string(),
                agent,
                status,
                summary: summary_str.to_string(),
            },
            now_ms,
        );
        guard.active_state(now_ms)
    };
    engine.last_hook_state = Some(next_state);
    engine.inner.set_state(next_state);
    true
}

#[no_mangle]
pub unsafe extern "C" fn petdex_engine_start_hook_server(
    engine: *mut PetdexEngine,
    port: u16,
    token_ptr: *const c_char,
    token_len: usize,
) -> u16 {
    let Some(engine) = engine.as_mut() else {
        return 0;
    };

    let token = if token_len == 0 {
        String::new()
    } else {
        if token_ptr.is_null() {
            return 0;
        }
        let bytes = std::slice::from_raw_parts(token_ptr as *const u8, token_len);
        match std::str::from_utf8(bytes) {
            Ok(s) => s.to_string(),
            Err(_) => return 0,
        }
    };

    engine.hook_server = None;

    let config = HookServerConfig::new(port, token);
    match HookServer::start(config, Arc::clone(&engine.attention)) {
        Ok(server) => {
            let bound_port = server.port();
            let active = {
                let guard = engine.attention.lock().unwrap_or_else(|e| e.into_inner());
                guard.active_state(current_time_ms())
            };
            engine.last_hook_state = Some(active);
            engine.hook_server = Some(server);
            bound_port
        }
        Err(_) => 0,
    }
}

#[no_mangle]
pub unsafe extern "C" fn petdex_engine_stop_hook_server(engine: *mut PetdexEngine) {
    if let Some(engine) = engine.as_mut() {
        engine.hook_server = None;
    }
}

#[no_mangle]
pub unsafe extern "C" fn petdex_engine_tick_ms(
    engine: *mut PetdexEngine,
    dt_ms: u32,
) -> PetdexFrame {
    let Some(engine) = engine.as_mut() else {
        return PetdexFrame {
            state: PetState::Idle as u8,
            row: 0,
            col: 0,
            frame_index: 0,
            frame_dur_ms: 0,
        };
    };
    if engine.hook_server.is_some() {
        let active = {
            let guard = engine.attention.lock().unwrap_or_else(|e| e.into_inner());
            guard.active_state(current_time_ms())
        };
        if engine.last_hook_state != Some(active) {
            engine.last_hook_state = Some(active);
            engine.inner.set_state(active);
        }
    }
    PetdexFrame::from(engine.inner.tick(dt_ms))
}

#[no_mangle]
pub unsafe extern "C" fn petdex_engine_active_bubble_json(
    engine: *mut PetdexEngine,
    now_ms: u64,
    out_buf: *mut u8,
    out_cap: usize,
) -> usize {
    if out_buf.is_null() || out_cap == 0 {
        return 0;
    }
    let Some(engine) = engine.as_mut() else {
        *out_buf = 0;
        return 0;
    };

    let top = {
        let guard = engine.attention.lock().unwrap_or_else(|e| e.into_inner());
        guard.active_bubbles(now_ms).into_iter().next()
    };

    let Some(bubble) = top else {
        *out_buf = 0;
        return 0;
    };

    let json = format!(
        r#"{{"session_id":{},"agent":{},"status":{},"summary":{}}}"#,
        escape_json_str(&bubble.session_id),
        escape_json_str(bubble.agent.spec().slug),
        escape_json_str(bubble.status.slug()),
        escape_json_str(&bubble.summary),
    );
    let bytes = json.as_bytes();
    let copy_len = bytes.len().min(out_cap - 1);
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_buf, copy_len);
    *out_buf.add(copy_len) = 0;
    copy_len
}

#[no_mangle]
pub unsafe extern "C" fn petdex_engine_active_bubbles_json(
    engine: *mut PetdexEngine,
    now_ms: u64,
    out_buf: *mut u8,
    out_cap: usize,
) -> usize {
    if out_buf.is_null() || out_cap == 0 {
        return 0;
    }
    let Some(engine) = engine.as_mut() else {
        *out_buf = 0;
        return 0;
    };

    let bubbles = {
        let guard = engine.attention.lock().unwrap_or_else(|e| e.into_inner());
        guard.active_bubbles(now_ms)
    };

    if bubbles.is_empty() {
        *out_buf = 0;
        return 0;
    }

    let mut json = String::from("[");
    for (idx, bubble) in bubbles.iter().enumerate() {
        if idx > 0 {
            json.push(',');
        }
        json.push_str(&format!(
            r#"{{"session_id":{},"agent":{},"status":{},"summary":{}}}"#,
            escape_json_str(&bubble.session_id),
            escape_json_str(bubble.agent.spec().slug),
            escape_json_str(bubble.status.slug()),
            escape_json_str(&bubble.summary),
        ));
    }
    json.push(']');

    let bytes = json.as_bytes();
    let copy_len = bytes.len().min(out_cap - 1);
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_buf, copy_len);
    *out_buf.add(copy_len) = 0;
    copy_len
}

#[no_mangle]
pub unsafe extern "C" fn petdex_engine_dismiss_session(
    engine: *mut PetdexEngine,
    session_id_ptr: *const c_char,
) -> bool {
    let Some(engine) = engine.as_mut() else {
        return false;
    };
    if session_id_ptr.is_null() {
        return false;
    }
    let Ok(session_id_str) = CStr::from_ptr(session_id_ptr).to_str() else {
        return false;
    };
    let mut guard = engine.attention.lock().unwrap_or_else(|e| e.into_inner());
    guard.dismiss(session_id_str)
}

#[no_mangle]
pub unsafe extern "C" fn petdex_write_runtime_token(token_ptr: *const c_char) -> bool {
    if token_ptr.is_null() {
        return false;
    }
    let Ok(token) = CStr::from_ptr(token_ptr).to_str() else {
        return false;
    };
    crate::runtime_token::write_runtime_token(token).is_ok()
}

#[no_mangle]
pub extern "C" fn petdex_agent_status(agent: u8) -> u8 {
    let Some(agent) = CodingAgent::from_u8(agent) else {
        return AgentInstallStatus::NotFound as u8;
    };
    detect_agent_status(agent) as u8
}

#[no_mangle]
pub extern "C" fn petdex_agent_connect(agent: u8) -> bool {
    let Some(agent) = CodingAgent::from_u8(agent) else {
        return false;
    };
    connect_agent(agent).unwrap_or(false)
}

#[no_mangle]
pub extern "C" fn petdex_agent_disconnect(agent: u8) -> bool {
    let Some(agent) = CodingAgent::from_u8(agent) else {
        return false;
    };
    disconnect_agent(agent).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use std::ffi::{CStr, CString};

    use super::*;

    #[test]
    fn ffi_version_matches_cargo_pkg_version() {
        let raw = petdex_core_version();
        assert!(!raw.is_null());
        let version = unsafe { CStr::from_ptr(raw) }.to_str().unwrap();
        assert_eq!(version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn ffi_engine_lifecycle_and_null_safety() {
        unsafe {
            assert!(!petdex_engine_set_state(std::ptr::null_mut(), 0));
            let null_frame = petdex_engine_tick_ms(std::ptr::null_mut(), 16);
            assert_eq!(null_frame.frame_dur_ms, 0);
            petdex_engine_free(std::ptr::null_mut());

            let engine = petdex_engine_new();
            assert!(!engine.is_null());

            let idle_blink = petdex_engine_tick_ms(engine, 280);
            assert_eq!(idle_blink.state, PetState::Idle as u8);
            assert_eq!(idle_blink.row, 0);
            assert_eq!(idle_blink.col, 1);

            assert!(!petdex_engine_set_state(engine, 99));
            assert!(petdex_engine_set_state(engine, PetState::Running as u8));

            let run_frame = petdex_engine_tick_ms(engine, 0);
            assert_eq!(run_frame.state, PetState::Running as u8);
            assert_eq!(run_frame.row, 7);
            assert_eq!(run_frame.col, 0);
            assert_eq!(run_frame.frame_dur_ms, 120);

            petdex_engine_free(engine);
        }
    }

    #[test]
    fn ffi_ingest_status_updates_active_pet_state() {
        unsafe {
            let engine = petdex_engine_new();
            let sid = CString::new("sess-1").unwrap();
            let summary = CString::new("Waiting for approval").unwrap();

            assert!(!petdex_engine_ingest_status(
                std::ptr::null_mut(),
                sid.as_ptr(),
                CodingAgent::ClaudeCode as u8,
                SessionStatus::NeedsInput as u8,
                summary.as_ptr(),
                1_000,
            ));
            assert!(!petdex_engine_ingest_status(
                engine,
                std::ptr::null(),
                CodingAgent::ClaudeCode as u8,
                SessionStatus::NeedsInput as u8,
                summary.as_ptr(),
                1_000,
            ));

            assert!(petdex_engine_ingest_status(
                engine,
                sid.as_ptr(),
                CodingAgent::ClaudeCode as u8,
                SessionStatus::NeedsInput as u8,
                summary.as_ptr(),
                1_000,
            ));

            let frame = petdex_engine_tick_ms(engine, 0);
            assert_eq!(frame.state, PetState::Waiting as u8);
            assert_eq!(frame.row, 6);

            assert!(petdex_engine_ingest_status(
                engine,
                sid.as_ptr(),
                CodingAgent::ClaudeCode as u8,
                SessionStatus::Idle as u8,
                std::ptr::null(),
                2_000,
            ));

            let idle_frame = petdex_engine_tick_ms(engine, 0);
            assert_eq!(idle_frame.state, PetState::Idle as u8);
            assert_eq!(idle_frame.row, 0);

            petdex_engine_free(engine);
        }
    }

    #[test]
    fn ffi_hook_server_receives_post_state_and_updates_tick() {
        use std::io::{Read, Write};
        use std::net::TcpStream;

        unsafe {
            assert_eq!(
                petdex_engine_start_hook_server(std::ptr::null_mut(), 0, std::ptr::null(), 0),
                0
            );

            let engine = petdex_engine_new();
            assert_eq!(
                petdex_engine_start_hook_server(engine, 0, std::ptr::null(), 4),
                0
            );

            let token = "ffi-secret";
            let port = petdex_engine_start_hook_server(
                engine,
                0,
                token.as_ptr() as *const c_char,
                token.len(),
            );
            assert!(port > 0);

            let body = r#"{"session_id":"hook-1","agent":"claude-code","status":"needs-input","summary":"Approve"}"#;
            let req = format!(
                "POST /state HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Petdex-Update-Token: {token}\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect hook server");
            stream.write_all(req.as_bytes()).expect("write request");
            stream.flush().expect("flush request");

            let mut resp = String::new();
            stream.read_to_string(&mut resp).expect("read response");
            assert!(resp.starts_with("HTTP/1.1 200 OK"));

            let frame = petdex_engine_tick_ms(engine, 16);
            assert_eq!(frame.state, PetState::Waiting as u8);
            assert_eq!(frame.row, 6);

            petdex_engine_stop_hook_server(engine);
            petdex_engine_free(engine);
        }
    }

    #[test]
    fn ffi_active_bubble_json_idle_and_active() {
        unsafe {
            let mut buf = [0u8; 512];
            assert_eq!(
                petdex_engine_active_bubble_json(
                    std::ptr::null_mut(),
                    1_000,
                    buf.as_mut_ptr(),
                    buf.len()
                ),
                0
            );

            let engine = petdex_engine_new();
            assert_eq!(
                petdex_engine_active_bubble_json(engine, 1_000, std::ptr::null_mut(), 16),
                0
            );
            assert_eq!(
                petdex_engine_active_bubble_json(engine, 1_000, buf.as_mut_ptr(), 0),
                0
            );

            buf[0] = b'x';
            assert_eq!(
                petdex_engine_active_bubble_json(engine, 1_000, buf.as_mut_ptr(), buf.len()),
                0
            );
            assert_eq!(buf[0], 0);

            let sid = CString::new("sess-bubble").unwrap();
            let summary = CString::new("Waiting for \"approval\"").unwrap();
            assert!(petdex_engine_ingest_status(
                engine,
                sid.as_ptr(),
                CodingAgent::ClaudeCode as u8,
                SessionStatus::NeedsInput as u8,
                summary.as_ptr(),
                1_000,
            ));

            let len = petdex_engine_active_bubble_json(engine, 1_500, buf.as_mut_ptr(), buf.len());
            assert!(len > 0);
            assert_eq!(buf[len], 0);

            let text = std::str::from_utf8(&buf[..len]).expect("valid utf-8");
            let parsed = crate::json::parse_json(text).expect("valid json");
            assert_eq!(parsed.get_str("session_id"), Some("sess-bubble"));
            assert_eq!(parsed.get_str("agent"), Some("claude-code"));
            assert_eq!(parsed.get_str("status"), Some("needs-input"));
            assert_eq!(parsed.get_str("summary"), Some("Waiting for \"approval\""));

            petdex_engine_free(engine);
        }
    }

    #[test]
    fn ffi_active_bubbles_json_orders_multiple_sessions_by_priority() {
        unsafe {
            let mut buf = [0u8; 1024];
            assert_eq!(
                petdex_engine_active_bubbles_json(
                    std::ptr::null_mut(),
                    1_000,
                    buf.as_mut_ptr(),
                    buf.len()
                ),
                0
            );

            let engine = petdex_engine_new();
            buf[0] = b'x';
            assert_eq!(
                petdex_engine_active_bubbles_json(engine, 1_000, buf.as_mut_ptr(), buf.len()),
                0
            );
            assert_eq!(buf[0], 0);

            let s_run = CString::new("sess-running").unwrap();
            let sum_run = CString::new("Building crate").unwrap();
            assert!(petdex_engine_ingest_status(
                engine,
                s_run.as_ptr(),
                CodingAgent::Codex as u8,
                SessionStatus::Running as u8,
                sum_run.as_ptr(),
                1_000,
            ));

            let s_fail = CString::new("sess-failed").unwrap();
            let sum_fail = CString::new("Tests failed").unwrap();
            assert!(petdex_engine_ingest_status(
                engine,
                s_fail.as_ptr(),
                CodingAgent::Gemini as u8,
                SessionStatus::Failed as u8,
                sum_fail.as_ptr(),
                1_100,
            ));

            let s_wait = CString::new("sess-waiting").unwrap();
            let sum_wait = CString::new("Approve tool").unwrap();
            assert!(petdex_engine_ingest_status(
                engine,
                s_wait.as_ptr(),
                CodingAgent::ClaudeCode as u8,
                SessionStatus::NeedsInput as u8,
                sum_wait.as_ptr(),
                1_200,
            ));

            let len = petdex_engine_active_bubbles_json(engine, 1_500, buf.as_mut_ptr(), buf.len());
            assert!(len > 0);
            assert_eq!(buf[len], 0);

            let text = std::str::from_utf8(&buf[..len]).expect("valid utf-8");
            assert!(text.starts_with('['));
            assert!(text.ends_with(']'));

            let wait_pos = text.find("sess-waiting").expect("waiting session");
            let fail_pos = text.find("sess-failed").expect("failed session");
            let run_pos = text.find("sess-running").expect("running session");
            assert!(wait_pos < fail_pos && fail_pos < run_pos);

            petdex_engine_free(engine);
        }
    }

    #[test]
    fn ffi_dismiss_session_removes_only_target_session() {
        unsafe {
            let engine = petdex_engine_new();
            let s1 = CString::new("sess-1").unwrap();
            let s2 = CString::new("sess-2").unwrap();
            let sum1 = CString::new("First").unwrap();
            let sum2 = CString::new("Second").unwrap();

            assert!(!petdex_engine_dismiss_session(std::ptr::null_mut(), s1.as_ptr()));
            assert!(!petdex_engine_dismiss_session(engine, std::ptr::null()));
            assert!(!petdex_engine_dismiss_session(engine, s1.as_ptr()));

            assert!(petdex_engine_ingest_status(
                engine,
                s1.as_ptr(),
                CodingAgent::ClaudeCode as u8,
                SessionStatus::NeedsInput as u8,
                sum1.as_ptr(),
                1_000,
            ));
            assert!(petdex_engine_ingest_status(
                engine,
                s2.as_ptr(),
                CodingAgent::Codex as u8,
                SessionStatus::Running as u8,
                sum2.as_ptr(),
                1_100,
            ));

            assert!(petdex_engine_dismiss_session(engine, s1.as_ptr()));
            assert!(!petdex_engine_dismiss_session(engine, s1.as_ptr()));

            let mut buf = [0u8; 512];
            let len = petdex_engine_active_bubbles_json(engine, 1_500, buf.as_mut_ptr(), buf.len());
            assert!(len > 0);
            let text = std::str::from_utf8(&buf[..len]).expect("valid utf-8");
            assert!(!text.contains("sess-1"));
            assert!(text.contains("sess-2"));

            petdex_engine_free(engine);
        }
    }

    #[test]
    fn ffi_agent_hook_functions_reject_invalid_agent_id() {
        assert_eq!(petdex_agent_status(255), AgentInstallStatus::NotFound as u8);
        assert!(!petdex_agent_connect(255));
        assert!(!petdex_agent_disconnect(255));
    }
}
