# petdex-windows

Native Windows desktop shell for Petdex built in Rust on top of `petdex-core` with zero external crate dependencies.

## Architecture

- Depends only on `petdex-core` (`path = "../petdex-core"`).
- Uses direct `#[cfg(target_os = "windows")]` `extern "system"` FFI bindings to `user32.dll`, `kernel32.dll`, `gdi32.dll`, and `shell32.dll`.
- Creates a borderless transparent topmost tool window (`WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW`, `0x00080088`) via `RegisterClassExW`, `CreateWindowExW`, and `SetLayeredWindowAttributes`.
- Supports left-click dragging via `WM_NCHITTEST` (`HTCAPTION`), right-click context menu (`CreatePopupMenu`, `AppendMenuW`, `TrackPopupMenu`), and a system tray icon (`Shell_NotifyIconW`).
- Runs a Win32 timer (`SetTimer`) that ticks `PetAnimationEngine` and syncs state from the loopback `HookServer` (`AttentionCoordinator`).
- Slices `8x9` sprite atlas frames and computes work-area placement in pure Rust so unit tests run on Windows, macOS, and Linux.

## Build and Run

Run tests on any OS:

```sh
cd crates/petdex-windows
cargo test
```

Build the release binary on Windows:

```sh
cd crates/petdex-windows
cargo build --release
```

Run the Windows host (optional environment overrides):

```sh
PETDEX_HOOK_PORT=7777 PETDEX_UPDATE_TOKEN=petdex-dev-token cargo run --release
```
