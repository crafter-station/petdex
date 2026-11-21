use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::agents::CodingAgent;
use crate::attention::{AgentEvent, AttentionCoordinator, SessionStatus};
use crate::json::{escape_json_str, parse_json, JsonValue};

pub const DEFAULT_HOOK_PORT: u16 = 7777;
pub const UPDATE_TOKEN_HEADER: &str = "x-petdex-update-token";

const MAX_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct HookServerConfig {
    pub port: u16,
    pub update_token: String,
}

impl HookServerConfig {
    pub fn new(port: u16, update_token: impl Into<String>) -> Self {
        Self {
            port,
            update_token: update_token.into(),
        }
    }

    pub fn with_default_port(update_token: impl Into<String>) -> Self {
        Self::new(DEFAULT_HOOK_PORT, update_token)
    }
}

pub struct HookServer {
    local_addr: SocketAddr,
    stop_flag: Arc<AtomicBool>,
    coordinator: Arc<Mutex<AttentionCoordinator>>,
    handle: Option<JoinHandle<()>>,
}

impl HookServer {
    pub fn start(
        config: HookServerConfig,
        coordinator: Arc<Mutex<AttentionCoordinator>>,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", config.port))?;
        let local_addr = listener.local_addr()?;
        let stop_flag = Arc::new(AtomicBool::new(false));

        let thread_stop = Arc::clone(&stop_flag);
        let thread_coord = Arc::clone(&coordinator);
        let token = config.update_token;

        let handle = thread::spawn(move || {
            for incoming in listener.incoming() {
                if thread_stop.load(Ordering::Acquire) {
                    break;
                }
                if let Ok(stream) = incoming {
                    let _ = handle_connection(stream, &token, &thread_coord);
                }
            }
        });

        Ok(Self {
            local_addr,
            stop_flag,
            coordinator,
            handle: Some(handle),
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn port(&self) -> u16 {
        self.local_addr.port()
    }

    pub fn coordinator(&self) -> &Arc<Mutex<AttentionCoordinator>> {
        &self.coordinator
    }

    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Release);
        let _ = TcpStream::connect(self.local_addr);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for HookServer {
    fn drop(&mut self) {
        self.stop();
    }
}

struct HttpRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl HttpRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

fn handle_connection(
    mut stream: TcpStream,
    expected_token: &str,
    coordinator: &Arc<Mutex<AttentionCoordinator>>,
) -> io::Result<()> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));

    let Some(req) = read_http_request(&mut stream)? else {
        return Ok(());
    };

    let path = req.path.split('?').next().unwrap_or(req.path.as_str());
    let (status_line, body) = match (req.method.as_str(), path) {
        ("GET", "/health") => (
            "200 OK",
            r#"{"ok":true,"status":"healthy"}"#.to_string(),
        ),
        ("GET", "/state") => {
            let now = now_ms();
            let guard = coordinator.lock().unwrap_or_else(|e| e.into_inner());
            let pet_state = guard.active_state(now).slug();
            let bubbles = guard.active_bubbles(now);
            let mut items = Vec::with_capacity(bubbles.len());
            for b in &bubbles {
                items.push(format!(
                    r#"{{"session_id":{},"agent":{},"status":{},"summary":{}}}"#,
                    escape_json_str(&b.session_id),
                    escape_json_str(b.agent.spec().slug),
                    escape_json_str(b.status.slug()),
                    escape_json_str(&b.summary),
                ));
            }
            (
                "200 OK",
                format!(
                    r#"{{"ok":true,"pet_state":{},"active_bubbles":{},"bubbles":[{}]}}"#,
                    escape_json_str(pet_state),
                    bubbles.len(),
                    items.join(","),
                ),
            )
        }
        ("POST", "/state") => {
            if !is_authorized(&req, expected_token) {
                ("401 Unauthorized", r#"{"error":"unauthorized"}"#.to_string())
            } else {
                handle_post_state(&req.body, coordinator)
            }
        }
        ("POST", "/bubble") => {
            if !is_authorized(&req, expected_token) {
                ("401 Unauthorized", r#"{"error":"unauthorized"}"#.to_string())
            } else {
                handle_post_bubble(&req.body, coordinator)
            }
        }
        _ => ("404 Not Found", r#"{"error":"not_found"}"#.to_string()),
    };

    write_http_response(&mut stream, status_line, &body)
}

fn handle_post_state(
    body: &str,
    coordinator: &Arc<Mutex<AttentionCoordinator>>,
) -> (&'static str, String) {
    let Ok(json) = parse_json(body) else {
        return ("400 Bad Request", r#"{"error":"invalid_json"}"#.to_string());
    };
    let Some(event) = parse_event_payload(&json) else {
        return ("400 Bad Request", r#"{"error":"invalid_payload"}"#.to_string());
    };

    let now = now_ms();
    let pet_state = {
        let mut guard = coordinator.lock().unwrap_or_else(|e| e.into_inner());
        guard.ingest(event, now);
        guard.active_state(now).slug()
    };

    (
        "200 OK",
        format!(
            r#"{{"ok":true,"pet_state":{}}}"#,
            escape_json_str(pet_state)
        ),
    )
}

fn handle_post_bubble(
    body: &str,
    coordinator: &Arc<Mutex<AttentionCoordinator>>,
) -> (&'static str, String) {
    let Ok(json) = parse_json(body) else {
        return ("400 Bad Request", r#"{"error":"invalid_json"}"#.to_string());
    };

    if json.get_bool("dismiss") == Some(true) {
        let Some(session_id) = json
            .get_str("session_id")
            .or_else(|| json.get_str("sessionId"))
        else {
            return ("400 Bad Request", r#"{"error":"missing_session_id"}"#.to_string());
        };
        let now = now_ms();
        let (dismissed, pet_state) = {
            let mut guard = coordinator.lock().unwrap_or_else(|e| e.into_inner());
            let removed = guard.dismiss(session_id);
            (removed, guard.active_state(now).slug())
        };
        return (
            "200 OK",
            format!(
                r#"{{"ok":true,"dismissed":{},"pet_state":{}}}"#,
                dismissed,
                escape_json_str(pet_state),
            ),
        );
    }

    handle_post_state(body, coordinator)
}

fn parse_event_payload(json: &JsonValue) -> Option<AgentEvent> {
    let session_id = json
        .get_str("session_id")
        .or_else(|| json.get_str("sessionId"))
        .unwrap_or("default")
        .to_string();

    let agent_slug = json
        .get_str("agent")
        .or_else(|| json.get_str("provider"))
        .unwrap_or("claude-code");
    let agent = CodingAgent::from_slug(agent_slug)?;

    let status_raw = json
        .get_str("status")
        .or_else(|| json.get_str("state"))?;
    let status = SessionStatus::from_str_name(status_raw)?;

    let summary = json
        .get_str("summary")
        .or_else(|| json.get_str("message"))
        .or_else(|| json.get_str("title"))
        .unwrap_or("")
        .to_string();

    Some(AgentEvent {
        session_id,
        agent,
        status,
        summary,
    })
}

fn is_authorized(req: &HttpRequest, expected_token: &str) -> bool {
    let Some(provided) = req.header(UPDATE_TOKEN_HEADER) else {
        return false;
    };
    constant_time_eq(provided.as_bytes(), expected_token.as_bytes())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn read_http_request(stream: &mut TcpStream) -> io::Result<Option<HttpRequest>> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let header_end = loop {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            if buf.is_empty() {
                return Ok(None);
            }
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_header_end(&buf) {
            break pos;
        }
        if buf.len() > MAX_REQUEST_BYTES {
            return Ok(None);
        }
    };

    let (method, path, headers, content_length) = {
        let head = String::from_utf8_lossy(&buf[..header_end]);
        let mut lines = head.split("\r\n");
        let request_line = lines.next().unwrap_or("");
        let mut parts = request_line.split_whitespace();
        let Some(method) = parts.next() else {
            return Ok(None);
        };
        let Some(path) = parts.next() else {
            return Ok(None);
        };

        let mut headers = Vec::new();
        let mut content_length: usize = 0;
        for line in lines {
            if let Some((k, v)) = line.split_once(':') {
                let key = k.trim().to_string();
                let val = v.trim().to_string();
                if key.eq_ignore_ascii_case("content-length") {
                    content_length = val.parse::<usize>().unwrap_or(0);
                }
                headers.push((key, val));
            }
        }
        (method.to_string(), path.to_string(), headers, content_length)
    };

    if content_length > MAX_REQUEST_BYTES {
        return Ok(None);
    }

    let body_start = header_end + 4;
    while buf.len() < body_start + content_length {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }

    let body_end = (body_start + content_length).min(buf.len());
    let body = String::from_utf8_lossy(&buf[body_start..body_end]).to_string();

    Ok(Some(HttpRequest {
        method,
        path,
        headers,
        body,
    }))
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn write_http_response(stream: &mut TcpStream, status: &str, body: &str) -> io::Result<()> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::animation::PetState;

    fn send_raw_http(port: u16, request: &str) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect loopback");
        stream.write_all(request.as_bytes()).expect("write request");
        stream.flush().expect("flush request");

        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read response");

        let (head, body) = response.split_once("\r\n\r\n").expect("valid http response");
        let status_code = head
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse::<u16>().ok())
            .expect("http status code");
        (status_code, body.to_string())
    }

    #[test]
    fn get_health_returns_200_ok() {
        let coord = Arc::new(Mutex::new(AttentionCoordinator::new()));
        let mut server =
            HookServer::start(HookServerConfig::new(0, "secret-token"), coord).unwrap();

        let (status, body) = send_raw_http(
            server.port(),
            "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        );

        assert_eq!(status, 200);
        assert!(body.contains(r#""ok":true"#));
        assert!(body.contains(r#""status":"healthy""#));
        server.stop();
    }

    #[test]
    fn post_state_rejects_missing_or_wrong_token_with_401() {
        let coord = Arc::new(Mutex::new(AttentionCoordinator::new()));
        let mut server =
            HookServer::start(HookServerConfig::new(0, "secret-token"), coord).unwrap();

        let payload = r#"{"session_id":"s1","agent":"claude-code","status":"running","summary":"working"}"#;
        let unauth_req = format!(
            "POST /state HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            payload.len(),
            payload
        );
        let (status, body) = send_raw_http(server.port(), &unauth_req);
        assert_eq!(status, 401);
        assert!(body.contains("unauthorized"));

        let wrong_token_req = format!(
            "POST /state HTTP/1.1\r\nHost: 127.0.0.1\r\nx-petdex-update-token: wrong\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            payload.len(),
            payload
        );
        let (status2, _) = send_raw_http(server.port(), &wrong_token_req);
        assert_eq!(status2, 401);

        server.stop();
    }

    #[test]
    fn post_state_and_bubble_with_valid_token_update_coordinator_and_get_state() {
        let coord = Arc::new(Mutex::new(AttentionCoordinator::new()));
        let mut server = HookServer::start(
            HookServerConfig::new(0, "valid-token-123"),
            Arc::clone(&coord),
        )
        .unwrap();

        let payload = r#"{"session_id":"claude-1","agent":"claude-code","status":"needs-input","summary":"Approve plan"}"#;
        let post_req = format!(
            "POST /state HTTP/1.1\r\nHost: 127.0.0.1\r\nx-petdex-update-token: valid-token-123\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            payload.len(),
            payload
        );
        let (status, body) = send_raw_http(server.port(), &post_req);
        assert_eq!(status, 200);
        assert!(body.contains(r#""pet_state":"waiting""#));

        {
            let guard = coord.lock().unwrap();
            assert_eq!(guard.active_state(now_ms()), PetState::Waiting);
        }

        let (get_status, get_body) = send_raw_http(
            server.port(),
            "GET /state HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        );
        assert_eq!(get_status, 200);
        assert!(get_body.contains(r#""pet_state":"waiting""#));
        assert!(get_body.contains(r#""session_id":"claude-1""#));
        assert!(get_body.contains(r#""summary":"Approve plan""#));

        let dismiss_payload = r#"{"session_id":"claude-1","dismiss":true}"#;
        let dismiss_req = format!(
            "POST /bubble HTTP/1.1\r\nHost: 127.0.0.1\r\nx-petdex-update-token: valid-token-123\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            dismiss_payload.len(),
            dismiss_payload
        );
        let (dismiss_status, dismiss_body) = send_raw_http(server.port(), &dismiss_req);
        assert_eq!(dismiss_status, 200);
        assert!(dismiss_body.contains(r#""dismissed":true"#));
        assert!(dismiss_body.contains(r#""pet_state":"idle""#));

        server.stop();
    }
}
