# petdex-core

Shared Rust domain core for Petdex Desktop native shells, as specified in `docs/adr/0001-desktop-native-rust-core.md`.

## Architecture

`petdex-core` uses pure Rust `std` with zero external crate dependencies and zero I/O in its domain modules. Each module exposes a small interface over a cohesive state machine or registry:

- `src/animation.rs`: `PetState` (all 9 sprite rows from `packages/petdex-desktop-native/src/sprite.zig`), `FrameSpec`, `StateDef`, and `PetAnimationEngine` (`new`, `set_state`, `tick`).
- `src/attention.rs`: `SessionStatus`, `AgentEvent`, `BubbleEntry`, and `AttentionCoordinator` (`ingest`, `active_state`, `active_bubbles`, `dismiss`, `prune`). Enforces priority (`NeedsInput` > `Failed` > `Running` > `Completed` > `Idle`), dwell expiry, and deterministic bubble stacking.
- `src/agents.rs`: `CodingAgent` (all 10 supported coding agents), `AgentSpec`, and the `AgentAdapter` trait seam with slug, display name, default relative config path, and durable recovery capability metadata.
- `src/hook_server.rs`: Pure `std::net::TcpListener` loopback HTTP server (`127.0.0.1:<port>`, default `7777`) serving `GET /health`, `GET /state`, and `x-petdex-update-token`-authenticated `POST /state` and `POST /bubble` into `Arc<Mutex<AttentionCoordinator>>`.
- `src/reconcile.rs`: Durable session log parsers for Claude JSONL, Gemini JSONL, OMP JSONL, and Hermes JSON verified against `packages/petdex-desktop-native/src/test-fixtures/session-reconcile/v1/*`.
- `src/ffi.rs` + `include/petdex_core.h`: Minimal C-ABI boundary (`extern "C"`) built as `rlib`, `staticlib`, and `cdylib` for direct linking from Swift (macOS AppKit + Metal) and Rust (Win32 + DirectComposition).

## C-ABI FFI Seam

See `include/petdex_core.h` for the full header, including `petdex_engine_ingest_status`:

```c
typedef struct PetdexEngine PetdexEngine;

typedef struct PetdexFrame {
    uint8_t state;
    uint32_t row;
    uint32_t col;
    uint32_t frame_index;
    uint32_t frame_dur_ms;
} PetdexFrame;

const char *petdex_core_version(void);
PetdexEngine *petdex_engine_new(void);
void petdex_engine_free(PetdexEngine *engine);
bool petdex_engine_set_state(PetdexEngine *engine, uint8_t state);
bool petdex_engine_ingest_status(
    PetdexEngine *engine,
    const char *session_id,
    uint8_t agent,
    uint8_t status,
    const char *summary,
    uint64_t now_ms
);
PetdexFrame petdex_engine_tick_ms(PetdexEngine *engine, uint32_t dt_ms);
```

## Verification

Run unit tests from `crates/petdex-core`:

```sh
cargo test
```
