use std::ffi::c_char;

use crate::animation::{FrameOutput, PetAnimationEngine, PetState};

const CORE_VERSION_CSTR: &[u8] = concat!(env!("CARGO_PKG_VERSION"), "\0").as_bytes();

pub struct PetdexEngine {
    inner: PetAnimationEngine,
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
    PetdexFrame::from(engine.inner.tick(dt_ms))
}

#[cfg(test)]
mod tests {
    use std::ffi::CStr;

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
}
