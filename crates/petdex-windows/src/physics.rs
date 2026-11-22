use petdex_core::PetState;

pub const SAMPLE_WINDOW_MS: u64 = 100;
pub const MAX_VELOCITY: f64 = 2600.0;
pub const THROW_THRESHOLD: f64 = 85.0;
pub const STOP_THRESHOLD: f64 = 18.0;
pub const DAMPING_BASE: f64 = 0.06;
pub const RESTITUTION: f64 = -0.58;

#[derive(Debug, Clone, Copy, PartialEq)]
struct DragSample {
    x: f64,
    y: f64,
    time_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PhysicsStep {
    pub x: f64,
    pub y: f64,
    pub suggested_state: Option<PetState>,
    pub finished: bool,
}

#[derive(Debug, Clone)]
pub struct PetPhysics {
    samples: Vec<DragSample>,
    vx: f64,
    vy: f64,
    throwing: bool,
}

impl Default for PetPhysics {
    fn default() -> Self {
        Self::new()
    }
}

impl PetPhysics {
    pub fn new() -> Self {
        Self {
            samples: Vec::with_capacity(16),
            vx: 0.0,
            vy: 0.0,
            throwing: false,
        }
    }

    pub fn is_throwing(&self) -> bool {
        self.throwing
    }

    #[allow(dead_code)]
    pub fn velocity(&self) -> (f64, f64) {
        (self.vx, self.vy)
    }

    #[allow(dead_code)]
    pub fn stop(&mut self) {
        self.samples.clear();
        self.vx = 0.0;
        self.vy = 0.0;
        self.throwing = false;
    }

    pub fn begin_drag(&mut self, x: f64, y: f64, now_ms: u64) {
        self.samples.clear();
        self.vx = 0.0;
        self.vy = 0.0;
        self.throwing = false;
        self.samples.push(DragSample {
            x,
            y,
            time_ms: now_ms,
        });
    }

    pub fn update_drag(&mut self, x: f64, y: f64, now_ms: u64) -> Option<PetState> {
        self.samples.push(DragSample {
            x,
            y,
            time_ms: now_ms,
        });
        self.trim_samples(now_ms);

        let (vx, vy) = self.sample_velocity()?;
        if vy.abs() > 220.0 {
            return Some(PetState::Jumping);
        }
        if vx > 140.0 {
            return Some(PetState::RunningRight);
        }
        if vx < -140.0 {
            return Some(PetState::RunningLeft);
        }
        None
    }

    pub fn end_drag(&mut self, x: f64, y: f64, now_ms: u64) -> bool {
        self.samples.push(DragSample {
            x,
            y,
            time_ms: now_ms,
        });
        self.trim_samples(now_ms);

        let velocity = self.sample_velocity();
        self.samples.clear();

        let Some((raw_vx, raw_vy)) = velocity else {
            self.vx = 0.0;
            self.vy = 0.0;
            self.throwing = false;
            return false;
        };

        let clamped_vx = raw_vx.clamp(-MAX_VELOCITY, MAX_VELOCITY);
        let clamped_vy = raw_vy.clamp(-MAX_VELOCITY, MAX_VELOCITY);
        let speed = clamped_vx.hypot(clamped_vy);

        if speed > THROW_THRESHOLD {
            self.vx = clamped_vx;
            self.vy = clamped_vy;
            self.throwing = true;
            return true;
        }

        self.vx = 0.0;
        self.vy = 0.0;
        self.throwing = false;
        false
    }

    pub fn step(
        &mut self,
        dt_sec: f64,
        x: f64,
        y: f64,
        width: i32,
        height: i32,
        work_area: (i32, i32, i32, i32),
    ) -> PhysicsStep {
        if !self.throwing || dt_sec <= 0.0 || !dt_sec.is_finite() {
            return PhysicsStep {
                x,
                y,
                suggested_state: None,
                finished: !self.throwing,
            };
        }

        let mut next_x = x + self.vx * dt_sec;
        let mut next_y = y + self.vy * dt_sec;

        let damping = DAMPING_BASE.powf(dt_sec);
        self.vx *= damping;
        self.vy *= damping;

        let (left, top, right, bottom) = work_area;
        let min_x = left as f64;
        let max_x = right.saturating_sub(width.max(0)).max(left) as f64;
        let min_y = top as f64;
        let max_y = bottom.saturating_sub(height.max(0)).max(top) as f64;

        if next_x < min_x {
            next_x = min_x;
            if self.vx < 0.0 {
                self.vx *= RESTITUTION;
            }
        } else if next_x > max_x {
            next_x = max_x;
            if self.vx > 0.0 {
                self.vx *= RESTITUTION;
            }
        }

        if next_y < min_y {
            next_y = min_y;
            if self.vy < 0.0 {
                self.vy *= RESTITUTION;
            }
        } else if next_y > max_y {
            next_y = max_y;
            if self.vy > 0.0 {
                self.vy *= RESTITUTION;
            }
        }

        if self.vx.hypot(self.vy) < STOP_THRESHOLD {
            self.vx = 0.0;
            self.vy = 0.0;
            self.throwing = false;
            return PhysicsStep {
                x: next_x,
                y: next_y,
                suggested_state: None,
                finished: true,
            };
        }

        let suggested_state = if self.vx > 90.0 {
            Some(PetState::RunningRight)
        } else if self.vx < -90.0 {
            Some(PetState::RunningLeft)
        } else if self.vy.abs() > 120.0 {
            Some(PetState::Jumping)
        } else {
            None
        };

        PhysicsStep {
            x: next_x,
            y: next_y,
            suggested_state,
            finished: false,
        }
    }

    fn trim_samples(&mut self, now_ms: u64) {
        let cutoff = now_ms.saturating_sub(SAMPLE_WINDOW_MS);
        self.samples.retain(|sample| sample.time_ms >= cutoff);
    }

    fn sample_velocity(&self) -> Option<(f64, f64)> {
        let first = self.samples.first()?;
        let last = self.samples.last()?;
        if last.time_ms <= first.time_ms {
            return None;
        }
        let dt_sec = (last.time_ms - first.time_ms) as f64 / 1000.0;
        if dt_sec <= 1e-4 {
            return None;
        }
        Some(((last.x - first.x) / dt_sec, (last.y - first.y) / dt_sec))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK_AREA: (i32, i32, i32, i32) = (0, 0, 1920, 1040);

    #[test]
    fn drag_sampling_trims_to_100ms_window_and_suggests_directional_states() {
        let mut physics = PetPhysics::new();
        physics.begin_drag(100.0, 200.0, 1000);
        // Move slowly first; this sample stays in the 100ms window while t=1000 expires at t=1120.
        assert_eq!(physics.update_drag(102.0, 200.0, 1050), None);
        // Sharp fling to the right inside the latest 100ms window (t=1050..1120, dt=70ms).
        assert_eq!(
            physics.update_drag(150.0, 200.0, 1120),
            Some(PetState::RunningRight)
        );
        // Reversing sharply to the left (t=1120..1180, dt=60ms; t=1050 expired).
        assert_eq!(
            physics.update_drag(100.0, 200.0, 1180),
            Some(PetState::RunningLeft)
        );
        // Strong vertical drag suggests jumping.
        physics.begin_drag(500.0, 500.0, 2000);
        assert_eq!(
            physics.update_drag(500.0, 440.0, 2050),
            Some(PetState::Jumping)
        );
    }

    #[test]
    fn end_drag_respects_throw_threshold_and_clamps_max_velocity() {
        let mut physics = PetPhysics::new();
        physics.begin_drag(100.0, 100.0, 0);
        // 4 px over 100 ms = 40 px/s < 85 px/s threshold.
        assert!(!physics.end_drag(104.0, 100.0, 100));
        assert!(!physics.is_throwing());

        // Extreme fling: 1000 px over 50 ms = 20000 px/s -> clamped to 2600 px/s.
        physics.begin_drag(100.0, 100.0, 0);
        assert!(physics.end_drag(1100.0, -900.0, 50));
        assert!(physics.is_throwing());
        let (vx, vy) = physics.velocity();
        assert!((vx - MAX_VELOCITY).abs() < 1e-6);
        assert!((vy + MAX_VELOCITY).abs() < 1e-6);
    }

    #[test]
    fn step_applies_exponential_damping_and_directional_states() {
        let mut physics = PetPhysics::new();
        physics.begin_drag(400.0, 400.0, 0);
        // 1000 px/s to the right.
        assert!(physics.end_drag(450.0, 400.0, 50));

        let dt = 0.05;
        let step = physics.step(dt, 450.0, 400.0, 160, 160, WORK_AREA);
        assert!(!step.finished);
        assert_eq!(step.suggested_state, Some(PetState::RunningRight));
        assert!((step.x - 500.0).abs() < 1e-6);

        let expected_vx = 1000.0 * DAMPING_BASE.powf(dt);
        assert!((physics.velocity().0 - expected_vx).abs() < 1e-6);

        // Pure vertical throw suggests Jumping.
        physics.begin_drag(400.0, 400.0, 0);
        assert!(physics.end_drag(400.0, 350.0, 50));
        let v_step = physics.step(0.016, 400.0, 350.0, 160, 160, WORK_AREA);
        assert!(!v_step.finished);
        assert_eq!(v_step.suggested_state, Some(PetState::Jumping));
    }

    #[test]
    fn step_bounces_elastically_off_all_four_edges_with_restitution() {
        let dt = 0.05;
        let damping = DAMPING_BASE.powf(dt);

        // Right edge bounce
        let mut right = PetPhysics::new();
        right.begin_drag(1700.0, 400.0, 0);
        assert!(right.end_drag(1750.0, 400.0, 50)); // vx = +1000
        let s = right.step(dt, 1750.0, 400.0, 160, 160, WORK_AREA);
        assert!((s.x - (1920.0 - 160.0)).abs() < 1e-6);
        assert!((right.velocity().0 - (1000.0 * damping * RESTITUTION)).abs() < 1e-6);
        assert_eq!(s.suggested_state, Some(PetState::RunningLeft));

        // Left edge bounce
        let mut left = PetPhysics::new();
        left.begin_drag(60.0, 400.0, 0);
        assert!(left.end_drag(10.0, 400.0, 50)); // vx = -1000
        let s = left.step(dt, 10.0, 400.0, 160, 160, WORK_AREA);
        assert!((s.x - 0.0).abs() < 1e-6);
        assert!((left.velocity().0 - (-1000.0 * damping * RESTITUTION)).abs() < 1e-6);
        assert_eq!(s.suggested_state, Some(PetState::RunningRight));

        // Top edge bounce
        let mut top = PetPhysics::new();
        top.begin_drag(400.0, 60.0, 0);
        assert!(top.end_drag(400.0, 10.0, 50)); // vy = -1000
        let s = top.step(dt, 400.0, 10.0, 160, 160, WORK_AREA);
        assert!((s.y - 0.0).abs() < 1e-6);
        assert!((top.velocity().1 - (-1000.0 * damping * RESTITUTION)).abs() < 1e-6);

        // Bottom edge bounce
        let mut bottom = PetPhysics::new();
        bottom.begin_drag(400.0, 820.0, 0);
        assert!(bottom.end_drag(400.0, 870.0, 50)); // vy = +1000
        let s = bottom.step(dt, 400.0, 870.0, 160, 160, WORK_AREA);
        assert!((s.y - (1040.0 - 160.0)).abs() < 1e-6);
        assert!((bottom.velocity().1 - (1000.0 * damping * RESTITUTION)).abs() < 1e-6);
    }

    #[test]
    fn throw_settles_smoothly_below_stop_threshold() {
        let mut physics = PetPhysics::new();
        physics.begin_drag(500.0, 500.0, 0);
        assert!(physics.end_drag(560.0, 480.0, 50));

        let mut x = 560.0;
        let mut y = 480.0;
        let mut steps = 0;
        let mut finished = false;
        while steps < 400 {
            let result = physics.step(0.016, x, y, 160, 160, WORK_AREA);
            x = result.x;
            y = result.y;
            steps += 1;
            if result.finished {
                finished = true;
                assert_eq!(result.suggested_state, None);
                break;
            }
        }

        assert!(finished, "throw should settle within 400 frames");
        assert!(!physics.is_throwing());
        assert_eq!(physics.velocity(), (0.0, 0.0));
    }
}
