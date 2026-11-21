#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum PetState {
    Idle = 0,
    RunningRight = 1,
    RunningLeft = 2,
    Waving = 3,
    Jumping = 4,
    Failed = 5,
    Waiting = 6,
    Running = 7,
    Review = 8,
}

impl PetState {
    pub const COUNT: usize = 9;

    pub const ALL: [PetState; Self::COUNT] = [
        PetState::Idle,
        PetState::RunningRight,
        PetState::RunningLeft,
        PetState::Waving,
        PetState::Jumping,
        PetState::Failed,
        PetState::Waiting,
        PetState::Running,
        PetState::Review,
    ];

    pub const fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(PetState::Idle),
            1 => Some(PetState::RunningRight),
            2 => Some(PetState::RunningLeft),
            3 => Some(PetState::Waving),
            4 => Some(PetState::Jumping),
            5 => Some(PetState::Failed),
            6 => Some(PetState::Waiting),
            7 => Some(PetState::Running),
            8 => Some(PetState::Review),
            _ => None,
        }
    }

    pub const fn next(self) -> Self {
        match ((self as u8) + 1) % (Self::COUNT as u8) {
            0 => PetState::Idle,
            1 => PetState::RunningRight,
            2 => PetState::RunningLeft,
            3 => PetState::Waving,
            4 => PetState::Jumping,
            5 => PetState::Failed,
            6 => PetState::Waiting,
            7 => PetState::Running,
            _ => PetState::Review,
        }
    }

    pub const fn slug(self) -> &'static str {
        match self {
            PetState::Idle => "idle",
            PetState::RunningRight => "running-right",
            PetState::RunningLeft => "running-left",
            PetState::Waving => "waving",
            PetState::Jumping => "jumping",
            PetState::Failed => "failed",
            PetState::Waiting => "waiting",
            PetState::Running => "running",
            PetState::Review => "review",
        }
    }

    pub const fn def(self) -> StateDef {
        state_def(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameSpec {
    pub col: u64,
    pub dur_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StateDef {
    pub row: u64,
    pub frames: &'static [FrameSpec],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameOutput {
    pub state: PetState,
    pub row: u64,
    pub col: u64,
    pub frame_index: u32,
    pub frame_dur_ms: u32,
}

const fn uniform<const N: usize>(dur_ms: u32, last_ms: u32) -> [FrameSpec; N] {
    let mut frames = [FrameSpec { col: 0, dur_ms: 0 }; N];
    let mut i = 0;
    while i < N {
        frames[i] = FrameSpec {
            col: i as u64,
            dur_ms: if i == N - 1 { last_ms } else { dur_ms },
        };
        i += 1;
    }
    frames
}

const IDLE_FRAMES: [FrameSpec; 6] = [
    FrameSpec { col: 0, dur_ms: 280 },
    FrameSpec { col: 1, dur_ms: 110 },
    FrameSpec { col: 2, dur_ms: 110 },
    FrameSpec { col: 3, dur_ms: 140 },
    FrameSpec { col: 4, dur_ms: 140 },
    FrameSpec { col: 5, dur_ms: 320 },
];
const RUNNING_RIGHT_FRAMES: [FrameSpec; 8] = uniform(120, 220);
const RUNNING_LEFT_FRAMES: [FrameSpec; 8] = uniform(120, 220);
const WAVING_FRAMES: [FrameSpec; 4] = uniform(140, 280);
const JUMPING_FRAMES: [FrameSpec; 5] = uniform(140, 280);
const FAILED_FRAMES: [FrameSpec; 8] = uniform(140, 240);
const WAITING_FRAMES: [FrameSpec; 6] = uniform(150, 260);
const RUNNING_FRAMES: [FrameSpec; 6] = uniform(120, 220);
const REVIEW_FRAMES: [FrameSpec; 6] = uniform(150, 280);

pub const fn state_def(state: PetState) -> StateDef {
    match state {
        PetState::Idle => StateDef {
            row: 0,
            frames: &IDLE_FRAMES,
        },
        PetState::RunningRight => StateDef {
            row: 1,
            frames: &RUNNING_RIGHT_FRAMES,
        },
        PetState::RunningLeft => StateDef {
            row: 2,
            frames: &RUNNING_LEFT_FRAMES,
        },
        PetState::Waving => StateDef {
            row: 3,
            frames: &WAVING_FRAMES,
        },
        PetState::Jumping => StateDef {
            row: 4,
            frames: &JUMPING_FRAMES,
        },
        PetState::Failed => StateDef {
            row: 5,
            frames: &FAILED_FRAMES,
        },
        PetState::Waiting => StateDef {
            row: 6,
            frames: &WAITING_FRAMES,
        },
        PetState::Running => StateDef {
            row: 7,
            frames: &RUNNING_FRAMES,
        },
        PetState::Review => StateDef {
            row: 8,
            frames: &REVIEW_FRAMES,
        },
    }
}

#[derive(Debug, Clone)]
pub struct PetAnimationEngine {
    state: PetState,
    frame_index: usize,
    elapsed_ms: u32,
}

impl Default for PetAnimationEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl PetAnimationEngine {
    pub const fn new() -> Self {
        Self {
            state: PetState::Idle,
            frame_index: 0,
            elapsed_ms: 0,
        }
    }

    pub const fn with_state(state: PetState) -> Self {
        Self {
            state,
            frame_index: 0,
            elapsed_ms: 0,
        }
    }

    pub const fn state(&self) -> PetState {
        self.state
    }

    pub fn set_state(&mut self, state: PetState) {
        if self.state != state {
            self.state = state;
            self.frame_index = 0;
            self.elapsed_ms = 0;
        }
    }

    pub fn current_frame(&self) -> FrameOutput {
        let def = state_def(self.state);
        let spec = def.frames[self.frame_index];
        FrameOutput {
            state: self.state,
            row: def.row,
            col: spec.col,
            frame_index: self.frame_index as u32,
            frame_dur_ms: spec.dur_ms,
        }
    }

    pub fn tick(&mut self, dt_ms: u32) -> FrameOutput {
        let def = state_def(self.state);
        let mut remaining = self.elapsed_ms.saturating_add(dt_ms);

        loop {
            let dur = def.frames[self.frame_index].dur_ms;
            if dur == 0 || remaining < dur {
                self.elapsed_ms = remaining;
                break;
            }
            remaining -= dur;
            self.frame_index = (self.frame_index + 1) % def.frames.len();
        }

        self.current_frame()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_nine_states_match_sprite_zig_table() {
        let expected: [(PetState, u64, usize, u32, u32); 9] = [
            (PetState::Idle, 0, 6, 280, 320),
            (PetState::RunningRight, 1, 8, 120, 220),
            (PetState::RunningLeft, 2, 8, 120, 220),
            (PetState::Waving, 3, 4, 140, 280),
            (PetState::Jumping, 4, 5, 140, 280),
            (PetState::Failed, 5, 8, 140, 240),
            (PetState::Waiting, 6, 6, 150, 260),
            (PetState::Running, 7, 6, 120, 220),
            (PetState::Review, 8, 6, 150, 280),
        ];

        assert_eq!(PetState::ALL.len(), 9);

        for (idx, (state, row, count, first_dur, last_dur)) in expected.iter().enumerate() {
            assert_eq!(PetState::from_u8(idx as u8), Some(*state));
            let def = state_def(*state);
            assert_eq!(def.row, *row);
            assert_eq!(def.frames.len(), *count);
            assert_eq!(def.frames[0].col, 0);
            assert_eq!(def.frames[0].dur_ms, *first_dur);
            assert_eq!(def.frames[count - 1].col, (*count - 1) as u64);
            assert_eq!(def.frames[count - 1].dur_ms, *last_dur);
        }

        assert_eq!(PetState::from_u8(9), None);
    }

    #[test]
    fn state_next_cycles_through_all_nine_states() {
        let mut current = PetState::Idle;
        for expected in PetState::ALL {
            assert_eq!(current, expected);
            current = current.next();
        }
        assert_eq!(current, PetState::Idle);
    }

    #[test]
    fn idle_blink_timing_is_exact() {
        let mut engine = PetAnimationEngine::new();
        assert_eq!(engine.current_frame().row, 0);
        assert_eq!(engine.current_frame().col, 0);

        let f = engine.tick(279);
        assert_eq!(f.col, 0);

        let f = engine.tick(1);
        assert_eq!(f.col, 1);
        assert_eq!(f.frame_dur_ms, 110);

        let f = engine.tick(110);
        assert_eq!(f.col, 2);
        assert_eq!(f.frame_dur_ms, 110);

        let f = engine.tick(110);
        assert_eq!(f.col, 3);
        assert_eq!(f.frame_dur_ms, 140);

        let f = engine.tick(140);
        assert_eq!(f.col, 4);
        assert_eq!(f.frame_dur_ms, 140);

        let f = engine.tick(140);
        assert_eq!(f.col, 5);
        assert_eq!(f.frame_dur_ms, 320);

        let f = engine.tick(320);
        assert_eq!(f.col, 0);
        assert_eq!(f.frame_index, 0);
    }

    #[test]
    fn every_state_wraps_cleanly_over_full_cycle() {
        for state in PetState::ALL {
            let mut engine = PetAnimationEngine::with_state(state);
            let def = state_def(state);
            let total_ms: u32 = def.frames.iter().map(|f| f.dur_ms).sum();

            for (idx, frame) in def.frames.iter().enumerate() {
                let current = engine.current_frame();
                assert_eq!(current.state, state);
                assert_eq!(current.row, def.row);
                assert_eq!(current.col, frame.col);
                assert_eq!(current.frame_index, idx as u32);
                engine.tick(frame.dur_ms);
            }

            assert_eq!(engine.current_frame().frame_index, 0);

            let mut single_step = PetAnimationEngine::with_state(state);
            let wrapped = single_step.tick(total_ms);
            assert_eq!(wrapped.frame_index, 0);
            assert_eq!(wrapped.col, 0);
        }
    }

    #[test]
    fn set_state_is_idempotent_and_resets_on_change() {
        let mut engine = PetAnimationEngine::new();
        engine.tick(300);
        assert_eq!(engine.current_frame().col, 1);

        engine.set_state(PetState::Idle);
        assert_eq!(engine.current_frame().col, 1);

        engine.set_state(PetState::Waiting);
        let frame = engine.current_frame();
        assert_eq!(frame.state, PetState::Waiting);
        assert_eq!(frame.row, 6);
        assert_eq!(frame.col, 0);
        assert_eq!(frame.frame_index, 0);
    }
}
