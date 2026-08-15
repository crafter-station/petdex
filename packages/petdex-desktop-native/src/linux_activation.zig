//! Polling-safe placeholder used by the shared presentation layer. The Linux
//! parity branch replaces this module with the X11 activation backend.

pub const Origin = enum(u8) { none, terminal, vscode, default_browser, codex };

pub fn available(origin: Origin, cwd: []const u8) bool {
    _ = origin;
    _ = cwd;
    return false;
}

pub fn activate(origin: Origin, cwd: []const u8) bool {
    _ = origin;
    _ = cwd;
    return false;
}
