# petdex-windows

Native Windows desktop shell scaffold for Petdex built in Rust on top of `petdex-core`.

## Architecture

- Depends directly on `petdex-core` (`path = "../petdex-core"`).
- Starts the loopback `HookServer` (`127.0.0.1:7777` by default, overridable via `PETDEX_HOOK_PORT` and `PETDEX_UPDATE_TOKEN`) sharing an `Arc<Mutex<AttentionCoordinator>>`.
- Drives `PetAnimationEngine` from coordinator state.
- Defines the Win32 layered overlay host seam using `WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW` (`0x00080088`), gated with `#[cfg(target_os = "windows")]` so cross-platform checks succeed on macOS and Linux.

## Verification

```sh
cargo check
```
