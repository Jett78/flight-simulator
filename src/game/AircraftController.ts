import { Space } from "@babylonjs/core/Maths/math.axis";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { InputManager } from "./InputManager";

/**
 * Simplified, semi-realistic flight model (Phase 4).
 *
 * This replaces the Phase 3 "fly exactly where the nose points" model
 * with a force-based simulation stepped at a fixed timestep by the
 * caller (FlightScene runs it at 120 Hz through an accumulator):
 *
 *   Forces (Newtons, semi-implicit Euler integration):
 *   - Thrust   along the nose, proportional to throttle.
 *   - Gravity  constant -9.81 m/s^2 * mass.
 *   - Lift     L = 1/2 * rho * v^2 * S * CL, acting perpendicular to the
 *              airflow in the aircraft's vertical plane. CL comes from
 *              the angle of attack (below), so lift genuinely depends on
 *              airspeed AND attitude — bank the wings and the lift vector
 *              tilts, which is what turns the aircraft.
 *   - Drag     D = 1/2 * rho * v^2 * S * CD opposite the velocity, with
 *              CD = parasite + induced (CL^2) + stall + high-speed rise.
 *
 *   Angle of attack: the angle between the nose and the velocity
 *   vector. CL grows linearly with AoA up to the stall angles
 *   (+15 / -12 degrees), then falls off while drag rises and control
 *   effectiveness + stability fade — the classic stall behaviour.
 *
 *   Assistance (gentle, game-oriented): heading/pitch stability that
 *   eases the nose toward the flight path (this is what makes banked
 *   turns coordinated), a mild auto-level when hands are off roll, and
 *   lateral (sideslip) damping. All fade out in a stall.
 *
 * Control conventions (unchanged from Phase 3):
 *   forward = -Z, up = +Y, right = +X
 *   W = nose down,  S = nose up        (yoke/stick style)
 *   A = bank left,  D = bank right
 *   Q = yaw left,   E = yaw right
 *   Shift = throttle up, Ctrl = throttle down
 *
 * The controller owns position/velocity/orientation state only; it
 * never touches the camera, the scene, or rendering.
 */

// --- Airframe / environment constants (tuned for a ~180m runway) ---
// Trainer-like numbers: thrust/weight ~0.48 with a speed lapse, and a
// big wing (low wing loading) so rotation happens at ~34 m/s. A T/W
// near 1.0 (first tuning pass) made the aircraft climb almost
// vertically hands-off — physically consistent, wrong game feel.
const MASS = 4600; // kg
const MAX_THRUST = 22000; // N at 100% throttle, static (sea level, v=0)
const THRUST_LAPSE_SPEED = 150; // thrust fades linearly with speed...
const THRUST_LAPSE_FLOOR = 0.3; // ...down to this fraction at high speed
const WING_AREA = 65; // m^2
const AIR_DENSITY = 1.225; // kg/m^3, sea level
const GRAVITY = 9.81; // m/s^2
const CL_ALPHA = 5.7; // lift coefficient per radian of AoA
const CL_MAX = 1.4;
const CL_MIN = -1.1;
const STALL_POS_DEG = 15;
const STALL_NEG_DEG = 12;
const CD_PARASITE = 0.05;
const CD_INDUCED_K = 0.05;
const CD_STALL = 0.3;

// --- Control constants ---
const THROTTLE_RATE = 0.45; // per second while Shift/Ctrl held
const PITCH_RATE = 0.8; // rad/s at full deflection & full effectiveness
const ROLL_RATE = 1.6; // rad/s
const YAW_RATE = 0.5; // rad/s
const INPUT_RESPONSE = 7; // 1/s — smoothing of control deflections

// --- World limits ---
const GROUND_Y = 2.41; // root height with wheels on the runway
const CEILING_Y = 500;
const MAX_SPEED = 140; // m/s absolute cap (numeric safety net)

const AXIS_RIGHT = new Vector3(1, 0, 0);
const AXIS_UP = new Vector3(0, 1, 0);
const AXIS_BACK = new Vector3(0, 0, 1);
const WORLD_UP = new Vector3(0, 1, 0);
const LOCAL_FORWARD = new Vector3(0, 0, -1);
const LOCAL_RIGHT = new Vector3(1, 0, 0);
const LOCAL_UP = new Vector3(0, 1, 0);

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const smoothstep = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};
/** Exponential approach of `current` toward `target`, dt-correct. */
function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** Clean snapshot of the simulation for HUD / debugging (Phase 4 §5). */
export interface FlightState {
  /** Airspeed in m/s (magnitude of the velocity vector). */
  airspeed: number;
  /** Height above the runway datum, metres. */
  altitude: number;
  /** Compass heading in degrees: 0 = -Z (down the runway), clockwise. */
  headingDeg: number;
  /** Vertical speed in m/s (+ = climbing). */
  verticalSpeed: number;
  /** Throttle setting, 0..1. */
  throttle: number;
  /** Angle of attack in degrees (+ = nose above the flight path). */
  angleOfAttackDeg: number;
  /** Attitude: pitch (+ = nose up) and roll (+ = banked right), degrees. */
  pitchDeg: number;
  rollDeg: number;
  /** True while the wheels rest on the ground. */
  grounded: boolean;
  /** 0 = fully attached airflow, 1 = fully stalled. */
  stallFactor: number;
  /** Last computed aerodynamic forces, Newtons (debug). */
  lift: number;
  drag: number;
  thrust: number;
}

export class AircraftController {
  private readonly aircraft: TransformNode;
  private readonly startPosition: Vector3;

  /** 0..1 throttle setting (Shift/Ctrl). */
  throttle = 0;
  /** World-space velocity (m/s) — the heart of the Phase 4 model. */
  readonly velocity = new Vector3();
  /** True while in contact with the ground. */
  grounded = true;

  // Smoothed control deflections, each -1..1
  private pitchInput = 0;
  private rollInput = 0;
  private yawInput = 0;

  // Last step's aerodynamic values (for getState / debugging)
  private _alphaDeg = 0;
  private _stallFactor = 0;
  private _lift = 0;
  private _drag = 0;
  private _thrust = 0;

  // Scratch objects (no per-step allocation)
  private readonly _matrix = new Matrix();
  private readonly _forward = new Vector3();
  private readonly _right = new Vector3();
  private readonly _up = new Vector3();
  private readonly _velDir = new Vector3();
  private readonly _liftDir = new Vector3();
  private readonly _force = new Vector3();
  private readonly _tmp = new Vector3();

  constructor(aircraft: TransformNode, startPosition: Vector3) {
    this.aircraft = aircraft;
    this.startPosition = startPosition.clone();
    this.reset();
  }

  /** Airspeed in m/s. */
  get airspeed(): number {
    return this.velocity.length();
  }

  /** Restore the exact initial state (also used by the R reset key). */
  reset(): void {
    this.aircraft.position.copyFrom(this.startPosition);
    if (!this.aircraft.rotationQuaternion) {
      this.aircraft.rotationQuaternion = new Quaternion();
    }
    this.aircraft.rotationQuaternion.copyFromFloats(0, 0, 0, 1);
    this.aircraft.rotation.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.throttle = 0;
    this.pitchInput = 0;
    this.rollInput = 0;
    this.yawInput = 0;
    this.grounded = true;
    this._alphaDeg = 0;
    this._stallFactor = 0;
    this._lift = 0;
    this._drag = 0;
    this._thrust = 0;
  }

  /**
   * Advance the simulation by exactly `dt` seconds. The caller runs
   * this at a fixed timestep (120 Hz) — see FlightScene.
   */
  step(dt: number, input: InputManager): void {
    if (dt <= 0) return;
    const node = this.aircraft;
    const wasGrounded = node.position.y <= GROUND_Y + 0.001;

    // ---------- Controls ----------
    if (input.isDown("ShiftLeft", "ShiftRight")) {
      this.throttle = Math.min(1, this.throttle + THROTTLE_RATE * dt);
    }
    if (input.isDown("ControlLeft", "ControlRight")) {
      this.throttle = Math.max(0, this.throttle - THROTTLE_RATE * dt);
    }
    this.pitchInput = damp(
      this.pitchInput,
      (input.isDown("KeyS") ? 1 : 0) + (input.isDown("KeyW") ? -1 : 0),
      INPUT_RESPONSE,
      dt,
    );
    this.rollInput = damp(
      this.rollInput,
      (input.isDown("KeyA") ? 1 : 0) + (input.isDown("KeyD") ? -1 : 0),
      INPUT_RESPONSE,
      dt,
    );
    this.yawInput = damp(
      this.yawInput,
      (input.isDown("KeyQ") ? 1 : 0) + (input.isDown("KeyE") ? -1 : 0),
      INPUT_RESPONSE,
      dt,
    );

    // ---------- Aerodynamic state ----------
    this.computeBasis();
    const speed = this.velocity.length();
    if (speed > 0.01) {
      this._velDir.copyFrom(this.velocity).scaleInPlace(1 / speed);
    } else {
      this._velDir.copyFrom(this._forward);
    }

    // Angle of attack: signed angle from the velocity vector to the nose
    let alphaRad = 0;
    if (speed > 0.5) {
      const fwdComp = Vector3.Dot(this._velDir, this._forward);
      const upComp = Vector3.Dot(this._velDir, this._up);
      alphaRad = Math.atan2(-upComp, fwdComp);
    }
    const alphaDeg = (alphaRad * 180) / Math.PI;
    this._alphaDeg = alphaDeg;

    // Lift coefficient: linear in AoA, clamped, then falls off post-stall
    let cl = clamp(CL_ALPHA * alphaRad, CL_MIN, CL_MAX);
    if (alphaDeg > STALL_POS_DEG) {
      cl = Math.max(0.45, CL_MAX - (alphaDeg - STALL_POS_DEG) * 0.09);
    } else if (alphaDeg < -STALL_NEG_DEG) {
      cl = -Math.max(0.45, -CL_MIN - (-alphaDeg - STALL_NEG_DEG) * 0.09);
    }
    const stallPos = clamp((alphaDeg - STALL_POS_DEG) / 7, 0, 1);
    const stallNeg = clamp((-alphaDeg - STALL_NEG_DEG) / 7, 0, 1);
    const stallFactor = Math.max(stallPos, stallNeg);
    this._stallFactor = stallFactor;

    // Drag coefficient: parasite + induced + stall + high-speed rise
    const dragRise = 0.25 * smoothstep((speed - 85) / 35);
    const cd = CD_PARASITE + CD_INDUCED_K * cl * cl + stallFactor * CD_STALL + dragRise;

    const dynamicPressure = 0.5 * AIR_DENSITY * speed * speed;
    const lift = dynamicPressure * WING_AREA * cl;
    const drag = dynamicPressure * WING_AREA * cd;
    // Engine thrust fades with airspeed (prop/jet lapse), floored so
    // the aircraft can still cruise at altitude speed.
    const lapse = clamp(1 - speed / THRUST_LAPSE_SPEED, THRUST_LAPSE_FLOOR, 1);
    const thrust = this.throttle * MAX_THRUST * lapse;
    this._lift = lift;
    this._drag = drag;
    this._thrust = thrust;

    // ---------- Forces -> velocity ----------
    this._forward.scaleToRef(thrust, this._force);
    this._force.y -= MASS * GRAVITY;
    if (speed > 0.5) {
      // Lift direction: perpendicular to airflow, in the wing plane
      Vector3.CrossToRef(this._right, this._velDir, this._liftDir);
      const liftDirLen = this._liftDir.length();
      if (liftDirLen > 0.001) {
        this._liftDir.scaleInPlace(1 / liftDirLen);
        this._liftDir.scaleToRef(lift, this._tmp);
        this._force.addInPlace(this._tmp);
      }
      this._velDir.scaleToRef(-drag, this._tmp);
      this._force.addInPlace(this._tmp);
    }
    this.velocity.addInPlace(this._force.scaleInPlace(dt / MASS));

    // Sideslip damping: fuselage side-drag bleeds sideways velocity,
    // keeping velocity and orientation consistent. Kept moderate —
    // too strong cancels the sideways acceleration that IS the turn
    // (found by the headless turn test).
    if (speed > 1) {
      const sideComp = Vector3.Dot(this.velocity, this._right);
      this._right.scaleToRef(-sideComp * (1 - Math.exp(-1.4 * dt)), this._tmp);
      this.velocity.addInPlace(this._tmp);
    }

    // Rolling friction while on the ground (plus a little brake feel
    // at idle so the aircraft can actually stop)
    if (wasGrounded) {
      const friction = this.throttle < 0.02 ? 1.1 : 0.35;
      const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
      if (hSpeed > 0.001) {
        const newHSpeed = Math.max(0, hSpeed - friction * dt);
        const scale = newHSpeed / hSpeed;
        this.velocity.x *= scale;
        this.velocity.z *= scale;
      }
    }

    // Absolute speed cap (drag rise should hold it near ~112 m/s anyway)
    const newSpeed = this.velocity.length();
    if (newSpeed > MAX_SPEED) this.velocity.scaleInPlace(MAX_SPEED / newSpeed);

    // ---------- Position ----------
    this.velocity.scaleToRef(dt, this._tmp);
    node.position.addInPlace(this._tmp);

    // Ground / ceiling contact
    if (node.position.y <= GROUND_Y) {
      node.position.y = GROUND_Y;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
    if (node.position.y > CEILING_Y) {
      node.position.y = CEILING_Y;
      if (this.velocity.y > 0) this.velocity.y = 0;
    }

    // ---------- Attitude ----------
    this.applyAttitude(dt, wasGrounded, speed, stallFactor, alphaDeg);
  }

  private applyAttitude(
    dt: number,
    grounded: boolean,
    speed: number,
    stallFactor: number,
    alphaDeg: number,
  ): void {
    const node = this.aircraft;

    if (grounded) {
      // Nose-wheel steering needs a little speed; pitch-up (rotation)
      // needs airflow. Roll/nose-down are clamped by the ground itself.
      const steer = clamp(speed / 5, 0, 1);
      if (this.yawInput !== 0) {
        node.rotate(AXIS_UP, this.yawInput * YAW_RATE * 1.2 * steer * dt, Space.LOCAL);
      }
      if (this.pitchInput > 0) {
        const airflow = clamp(speed / 32, 0, 1);
        node.rotate(AXIS_RIGHT, this.pitchInput * PITCH_RATE * airflow * dt, Space.LOCAL);
      }
      // Hard attitude clamps while the wheels carry the aircraft:
      // pitch between 0 and ~14 degrees, roll zeroed.
      this.computeBasis();
      const pitchAngle = Math.asin(clamp(this._forward.y, -1, 1));
      if (pitchAngle > 0.24) node.rotate(AXIS_RIGHT, -(pitchAngle - 0.24), Space.LOCAL);
      if (pitchAngle < 0) node.rotate(AXIS_RIGHT, -pitchAngle, Space.LOCAL);
      const rollError = Math.asin(clamp(this._right.y, -1, 1));
      if (rollError !== 0) node.rotate(AXIS_BACK, -rollError, Space.LOCAL);
      return;
    }

    // Airborne: control power grows with airspeed and fades in a stall
    const effectiveness = clamp(0.3 + speed / 38, 0.3, 1) * (1 - 0.5 * stallFactor);
    if (this.pitchInput !== 0) {
      node.rotate(AXIS_RIGHT, this.pitchInput * PITCH_RATE * effectiveness * dt, Space.LOCAL);
    }
    if (this.rollInput !== 0) {
      node.rotate(AXIS_BACK, this.rollInput * ROLL_RATE * effectiveness * dt, Space.LOCAL);
    }
    if (this.yawInput !== 0) {
      node.rotate(AXIS_UP, this.yawInput * YAW_RATE * effectiveness * dt, Space.LOCAL);
    }

    // Stall: the nose drops toward the flight path, controls feel weak
    if (stallFactor > 0) {
      node.rotate(AXIS_RIGHT, -Math.sign(alphaDeg) * stallFactor * 0.5 * dt, Space.LOCAL);
    }

    if (speed <= 8) return;

    // ---------- Gentle stability assistance ----------
    const stability = 1 - 0.75 * stallFactor;
    this.computeBasis();

    // Hands-off roll: ease back toward wings-level
    if (Math.abs(this.rollInput) < 0.15) {
      const rollAngle = Math.asin(clamp(this._right.y, -1, 1));
      node.rotate(AXIS_BACK, -rollAngle * 0.45 * stability * dt, Space.LOCAL);
    }

    // Coordinated turn: in a bank, lift's horizontal component curves
    // the flight path at Omega = g * tan(bank) / v. Rotating the nose
    // at that same rate keeps the turn coordinated (no sliding).
    const bankRight = -Math.asin(clamp(this._right.y, -1, 1));
    if (speed > 10 && Math.abs(bankRight) > 0.03) {
      const turnRate = clamp((GRAVITY * Math.tan(bankRight)) / speed, -0.6, 0.6);
      node.rotate(WORLD_UP, -turnRate * (1 - 0.5 * stallFactor) * dt, Space.WORLD);
    }

    // Heading stability (weathervane): ease the nose toward the
    // velocity's heading, cleaning up any residual sideslip angle.
    const noseX = this._forward.x;
    const noseZ = this._forward.z;
    const velX = this._velDir.x;
    const velZ = this._velDir.z;
    const noseLen = Math.hypot(noseX, noseZ);
    const velLen = Math.hypot(velX, velZ);
    if (noseLen > 0.05 && velLen > 0.05) {
      const ax = noseX / noseLen;
      const az = noseZ / noseLen;
      const bx = velX / velLen;
      const bz = velZ / velLen;
      const crossY = az * bx - ax * bz;
      const dot = ax * bx + az * bz;
      const headingError = Math.atan2(crossY, dot);
      const yawRate = clamp(0.8 * headingError, -0.4, 0.4) * stability;
      node.rotate(WORLD_UP, yawRate * dt, Space.WORLD);
    }

    // Pitch stability: ease the nose toward the flight-path angle
    const pitchError =
      Math.asin(clamp(this._velDir.y, -1, 1)) - Math.asin(clamp(this._forward.y, -1, 1));
    const pitchRate = clamp(0.55 * pitchError, -0.28, 0.28) * stability;
    node.rotate(AXIS_RIGHT, pitchRate * dt, Space.LOCAL);
  }

  /** Snapshot of the simulation for the HUD and debugging. */
  getState(): FlightState {
    this.computeBasis();
    const f = this._forward;
    const headingDeg = (Math.atan2(f.x, -f.z) * (180 / Math.PI) + 360) % 360;
    return {
      airspeed: this.velocity.length(),
      altitude: this.aircraft.position.y - GROUND_Y,
      headingDeg,
      verticalSpeed: this.velocity.y,
      throttle: this.throttle,
      angleOfAttackDeg: this._alphaDeg,
      pitchDeg: Math.asin(clamp(f.y, -1, 1)) * (180 / Math.PI),
      rollDeg: -Math.asin(clamp(this._right.y, -1, 1)) * (180 / Math.PI),
      grounded: this.grounded,
      stallFactor: this._stallFactor,
      lift: this._lift,
      drag: this._drag,
      thrust: this._thrust,
    };
  }

  /** Aircraft basis vectors (forward/right/up) in world space. */
  private computeBasis(): void {
    const q = this.aircraft.rotationQuaternion;
    if (!q) {
      this._forward.copyFrom(LOCAL_FORWARD);
      this._right.copyFrom(LOCAL_RIGHT);
      this._up.copyFrom(LOCAL_UP);
      return;
    }
    Matrix.FromQuaternionToRef(q, this._matrix);
    Vector3.TransformNormalToRef(LOCAL_FORWARD, this._matrix, this._forward);
    Vector3.TransformNormalToRef(LOCAL_RIGHT, this._matrix, this._right);
    Vector3.TransformNormalToRef(LOCAL_UP, this._matrix, this._up);
  }
}
