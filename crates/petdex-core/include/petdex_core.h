#ifndef PETDEX_CORE_H
#define PETDEX_CORE_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct PetdexEngine PetdexEngine;

typedef struct PetdexFrame {
    uint8_t state;
    uint32_t row;
    uint32_t col;
    uint32_t frame_index;
    uint32_t frame_dur_ms;
} PetdexFrame;

enum PetdexState {
    PETDEX_STATE_IDLE = 0,
    PETDEX_STATE_RUNNING_RIGHT = 1,
    PETDEX_STATE_RUNNING_LEFT = 2,
    PETDEX_STATE_WAVING = 3,
    PETDEX_STATE_JUMPING = 4,
    PETDEX_STATE_FAILED = 5,
    PETDEX_STATE_WAITING = 6,
    PETDEX_STATE_RUNNING = 7,
    PETDEX_STATE_REVIEW = 8
};

enum PetdexAgent {
    PETDEX_AGENT_CLAUDE_CODE = 0,
    PETDEX_AGENT_CODEX = 1,
    PETDEX_AGENT_GEMINI = 2,
    PETDEX_AGENT_OPENCODE = 3,
    PETDEX_AGENT_QODER = 4,
    PETDEX_AGENT_KIMI_CODE = 5,
    PETDEX_AGENT_CODEBUDDY = 6,
    PETDEX_AGENT_OMP = 7,
    PETDEX_AGENT_HERMES = 8,
    PETDEX_AGENT_DSH = 9
};

enum PetdexSessionStatus {
    PETDEX_STATUS_IDLE = 0,
    PETDEX_STATUS_COMPLETED = 1,
    PETDEX_STATUS_RUNNING = 2,
    PETDEX_STATUS_FAILED = 3,
    PETDEX_STATUS_NEEDS_INPUT = 4
};

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

#ifdef __cplusplus
}
#endif

#endif
