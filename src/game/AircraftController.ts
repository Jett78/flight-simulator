import { Space } from "@babylonjs/core/Maths/math.axis";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { InputManager } from "./InputManager";
import { AIRCRAFT_RADIUS, CONTACT_SKIN, OBSTACLE_CRASH_SPEED, type ObstacleField } from "./obstacles";

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
 *   Shift = throttle up (hold), Space = fast throttle cut,
 *   release both = power decays to zero (spring-loaded throttle)
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
const MAX_THRUST = 21000; // N at 100% throttle, static (sea level, v=0)
const THRUST_LAPSE_SPEED = 170; // thrust fades linearly with speed...
const THRUST_LAPSE_FLOOR = 0.3; // ...down to this fraction at high speed
const WING_AREA = 92; // m^2 (big wing: rotation ~28 m/s, liftoff roll ~100 m)
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
const TRIM_ALPHA = 0.115; // rad (~6.6 deg) — hands-off trim AoA, see pitch trim below

// --- Control constants ---
// Throttle is spring-loaded (Jeet's call, 2026-10-29): hold Shift and
// power rises; release every throttle key and power falls back toward
// zero on its own; Space is a fast cut. There is no "set and forget"
// lever position — the HUD throttle bar shows the live value.
const THROTTLE_UP_RATE = 0.6; // per second while Shift held
const THROTTLE_DOWN_RATE = 1.2; // per second while Space held (fast cut)
const THROTTLE_DECAY_RATE = 0.5; // per second when no throttle key held
const PITCH_RATE = 0.8; // rad/s at full deflection & full effectiveness
const ROLL_RATE = 1.6; // rad/s
const YAW_RATE = 0.5; // rad/s
const INPUT_RESPONSE = 7; // 1/s — smoothing of control deflections

// --- World limits ---
const GROUND_Y = 2.41; // root height with wheels on the runway
// Phase 7: the gear depth (root-to-wheel distance) is what turns a
// surface height into a root height anywhere in the world:
// contact root Y = surface height + GEAR_DEPTH (2.41 on the runway:
// 0.16 asphalt top + 2.25 gear).
const GEAR_DEPTH = 2.25;
// Touchdown verdict thresholds (Phase 7). Sink rates a trained pilot
// would call firm-but-fine, the hard band, and the crash line.
const SINK_SMOOTH = 2.5; // m/s — at or below: smooth touchdown
const SINK_CRASH = 5.5; // m/s — beyond: structural impact, crash
const ROLL_CRASH_DEG = 28; // bank at contact beyond this = wing strike
const PITCH_CRASH_DEG = -12; // nose-down at contact beyond this = nose slam
const TERRAIN_SLOPE_CRASH_DEG = 15; // hillside steeper than this = impact
const TERRAIN_SPEED_CRASH = 45; // m/s — too fast to roll out on rough ground
const BUMP_MAX_AIR_TIME = 0.4; // s — shorter airborne gaps are ground roll, not landings
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
/** What the aircraft is resting on / flying over (Phase 7). */
export type SurfaceKind = "runway" | "terrain" | "water";

/** One ground sample at a world position. */
export interface GroundInfo {
  /** World Y of the surface itself (runway top, terrain, sea). */
  height: number;
  surface: SurfaceKind;
  /** Terrain steepness in degrees (0 on the runway and the sea). */
  slopeDeg: number;
  /** Terrain gradient (dh/dx, dh/dz) — drives slope resistance on ground rolls. */
  gradeX: number;
  gradeZ: number;
  onRunway: boolean;
}

/**
 * Injected ground query — the controller never hard-codes the world.
 * FlightScene supplies the island+runway sampler (runway.ts); the
 * headless tests use the flat default (see the constructor).
 */
export type GroundSampler = (x: number, z: number) => GroundInfo;

/** The verdict of the most recent touchdown (Phase 7). */
export interface TouchdownInfo {
  quality: "smooth" | "hard" | "off-runway";
  surface: SurfaceKind;
  /** Vertical speed at contact, m/s (negative = descending). */
  verticalSpeed: number;
  /** Increments per touchdown so the HUD can react to a new one. */
  sequence: number;
}

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
  /** Phase 7 ground interaction: high-level flight phase. */
  phase: "ground" | "air" | "crashed";
  /** True while in contact with the runway asphalt. */
  onRunway: boolean;
  /** Surface currently under the aircraft. */
  surface: SurfaceKind;
  /** Height above the local surface, metres (0 on the ground). */
  heightAboveGround: number;
  /** World position (for approach/distance logic in the HUD). */
  posX: number;
  posZ: number;
  crashed: boolean;
  crashReason: string;
  /** Verdict of the latest touchdown, or null since the last liftoff. */
  touchdown: TouchdownInfo | null;
}

export class AircraftController {
  private readonly aircraft: TransformNode;
  private readonly startPosition: Vector3;

  /** 0..1 throttle setting (Shift/Space). */
  throttle = 0;
  /** World-space velocity (m/s) — the heart of the Phase 4 model. */
  readonly velocity = new Vector3();
  /** True while in contact with the ground. */
  grounded = true;
  /** Phase 7: latched crash state — controls freeze until reset(). */
  crashed = false;
  crashReason = "";
  /** Phase 7: verdict of the most recent touchdown. */
  lastTouchdown: TouchdownInfo | null = null;

  private readonly groundSampler: GroundSampler;
  /** Phase 13: solid buildings/trees, when the world provides them. */
  private readonly obstacles: ObstacleField | null;
  private lastGround: GroundInfo = {
    height: GROUND_Y - GEAR_DEPTH,
    surface: "runway",
    slopeDeg: 0,
    gradeX: 0,
    gradeZ: 0,
    onRunway: true,
  };
  private airTime = 0;
  private touchdownSeq = 0;

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

  constructor(
    aircraft: TransformNode,
    startPosition: Vector3,
    groundSampler?: GroundSampler,
    obstacles?: ObstacleField | null,
  ) {
    this.aircraft = aircraft;
    this.startPosition = startPosition.clone();
    this.obstacles = obstacles ?? null;
    // Default: the pre-Phase-7 flat world (runway datum everywhere).
    this.groundSampler =
      groundSampler ??
      (() => ({
        height: GROUND_Y - GEAR_DEPTH,
        surface: "runway" as SurfaceKind,
        slopeDeg: 0,
        gradeX: 0,
        gradeZ: 0,
        onRunway: true,
      }));
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
    this.crashed = false;
    this.crashReason = "";
    this.lastTouchdown = null;
    this.airTime = 0;
    this.lastGround = this.groundSampler(this.startPosition.x, this.startPosition.z);
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
    if (this.crashed) {
      // Frozen until reset(): no forces, no control response. The
      // HUD crash overlay offers the reset from here.
      this.grounded = true;
      return;
    }
    // Phase 7: the ground is whatever the sampler says is under the
    // aircraft (runway asphalt, island terrain, or the sea).
    const groundNow = this.groundSampler(node.position.x, node.position.z);
    this.lastGround = groundNow;
    const contactY = groundNow.height + GEAR_DEPTH;
    const wasGrounded = node.position.y <= contactY + 0.001;

    // ---------- Controls ----------
    // Spring-loaded throttle: Shift raises, Space cuts fast, and
    // with neither held the power decays to zero.
    if (input.isDown("ShiftLeft", "ShiftRight")) {
      this.throttle = Math.min(1, this.throttle + THROTTLE_UP_RATE * dt);
    } else if (input.isDown("Space")) {
      this.throttle = Math.max(0, this.throttle - THROTTLE_DOWN_RATE * dt);
    } else {
      this.throttle = Math.max(0, this.throttle - THROTTLE_DECAY_RATE * dt);
    }
    this.pitchInput = damp(
      this.pitchInput,
      (input.isDown("KeyS") ? 1 : 0) + (input.isDown("KeyW") ? -1 : 0),
      INPUT_RESPONSE,
      dt,
    );
    // Direction swap (Jeet, 2026-10-30): A rolls RIGHT, D rolls
    // LEFT — the reverse of the original mapping.
    this.rollInput = damp(
      this.rollInput,
      (input.isDown("KeyD") ? 1 : 0) + (input.isDown("KeyA") ? -1 : 0),
      INPUT_RESPONSE,
      dt,
    );
    // Direction swap (Jeet, 2026-10-30): Q yaws RIGHT, E yaws LEFT.
    this.yawInput = damp(
      this.yawInput,
      (input.isDown("KeyE") ? 1 : 0) + (input.isDown("KeyQ") ? -1 : 0),
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
    // at idle so the aircraft can actually stop). Rough ground rolls
    // noticeably worse than asphalt (Phase 7).
    if (wasGrounded) {
      const rolling = groundNow.surface === "runway" ? 0.35 : 0.85;
      const braking = groundNow.surface === "runway" ? 1.1 : 1.5;
      let friction = this.throttle < 0.02 ? braking : rolling;
      if (groundNow.surface === "terrain") {
        // Slope resistance: gravity's along-slope component fights
        // uphill rolls and feeds downhill ones, so a plane that puts
        // down on a hillside slides to a stop instead of motoring
        // over the crest.
        const hvx = this.velocity.x;
        const hvz = this.velocity.z;
        const hs = Math.hypot(hvx, hvz);
        if (hs > 0.5) {
          const gradeAlong = (groundNow.gradeX * hvx + groundNow.gradeZ * hvz) / hs;
          friction += GRAVITY * gradeAlong;
        }
        // Rolling into a near-cliff face is an impact, not a rollout.
        if (groundNow.slopeDeg > 24 && hs > 6) {
          this.registerCrash("Terrain impact — steep slope");
        }
      }
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

    // ---------- Obstacles: depenetration (0.13.2) ----------
    // Rotation since the last step (yawing while parked against a
    // wall, ground attitude clamps) can swing the sphere into a
    // surface without any translation. Clear that overlap BEFORE
    // integrating so the step never starts inside a building.
    this.resolveObstacles(false);

    // ---------- Position ----------
    this.velocity.scaleToRef(dt, this._tmp);
    node.position.addInPlace(this._tmp);

    // Ground / ceiling contact (Phase 7: terrain-aware). Re-sample at
    // the new position — the surface can change within one step.
    const ground = this.groundSampler(node.position.x, node.position.z);
    this.lastGround = ground;
    const groundContactY = ground.height + GEAR_DEPTH;
    if (node.position.y <= groundContactY) {
      const impactVy = this.velocity.y;
      const impactSpeed = this.velocity.length();
      node.position.y = groundContactY;
      if (this.velocity.y < 0) this.velocity.y = 0;
      if (!this.grounded) {
        if (this.airTime > BUMP_MAX_AIR_TIME) {
          // A real touchdown (not a bump in the ground roll): judge it.
          this.evaluateTouchdown(ground, impactVy, impactSpeed);
        } else if (impactVy < -9) {
          // Fell off an edge and slammed — a crash even in a "bump".
          this.registerCrash("Impact too hard — high sink rate");
        }
      }
      this.grounded = true;
      this.airTime = 0;
    } else {
      if (this.grounded) this.lastTouchdown = null; // liftoff consumes the verdict
      this.grounded = false;
      this.airTime += dt;
    }
    if (node.position.y > CEILING_Y) {
      node.position.y = CEILING_Y;
      if (this.velocity.y > 0) this.velocity.y = 0;
    }

    // ---------- Obstacles (Phase 13, contact model 0.13.2) ----------
    if (this.resolveObstacles(true)) return; // crashed into something fast

    // ---------- Attitude ----------
    this.applyAttitude(dt, wasGrounded, speed, stallFactor, alphaDeg);
  }

  /**
   * Solid-obstacle contact (Phase 13; smooth-contact model 0.13.2).
   *
   * Resolves sphere-vs-obstacle penetration iteratively (up to 3
   * passes, so corners where two faces meet settle instead of
   * flip-flopping between them). The query radius includes
   * CONTACT_SKIN, so contact engages a hair before the surface:
   * each pass pushes the aircraft back out to that skin distance
   * and projects the velocity onto the surface plane — the
   * into-wall component is removed, the along-wall component is
   * kept whole, so the aircraft SLIDES along buildings instead of
   * grinding, and a held press sits at one constant position.
   *
   * The pre-0.13.2 model also halved the whole velocity on every
   * contact step (×0.5 at 120 Hz): while merely GRAZING a wall —
   * taxiing parallel within the 4 m sphere — the aircraft was
   * permanently in "contact" and its speed was annihilated every
   * step, which felt like severe lag, and the repeated
   * penetrate→snap-back cycle made pressing into a wall jitter
   * and wander instead of settling.
   *
   * With checkCrash, a hit whose INTO-SURFACE speed exceeds
   * OBSTACLE_CRASH_SPEED registers the crash (position is still
   * pushed out, so the wreck rests outside the wall). The crash
   * test uses the into-surface component, not total speed:
   * sliding fast ALONG a wall is not an impact — only the
   * velocity driving INTO it counts. Every pass checks, so
   * sliding along one wall into a perpendicular one crashes
   * against the second. Returns true iff crashed.
   */
  private resolveObstacles(checkCrash: boolean): boolean {
    if (!this.obstacles || this.crashed) return false;
    const node = this.aircraft;
    let crashedNow = false;
    for (let i = 0; i < 3; i++) {
      const hit = this.obstacles.query(
        node.position.x,
        node.position.y,
        node.position.z,
        AIRCRAFT_RADIUS + CONTACT_SKIN,
      );
      if (!hit) break;
      const vn = this.velocity.x * hit.pushX + this.velocity.z * hit.pushZ;
      if (checkCrash && -vn > OBSTACLE_CRASH_SPEED) {
        this.registerCrash(`Crashed into ${hit.label}`);
        crashedNow = true;
      }
      node.position.x += hit.pushX * hit.depth;
      node.position.z += hit.pushZ * hit.depth;
      if (vn < 0) {
        this.velocity.x -= vn * hit.pushX;
        this.velocity.z -= vn * hit.pushZ;
      }
      if (crashedNow) break;
    }
    return crashedNow;
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
      // Soft bank limit (~35-50 degrees): rolling further into a steep
      // bank fades out; rolling back toward level always works. Keeps
      // beginners out of the uncompensated spiral-dive regime.
      this.computeBasis();
      const bankLeft = Math.asin(clamp(this._right.y, -1, 1));
      let rollAuthority = 1;
      if (this.rollInput > 0 && bankLeft > 0.61) {
        rollAuthority = 1 - smoothstep((bankLeft - 0.61) / 0.26);
      } else if (this.rollInput < 0 && bankLeft < -0.61) {
        rollAuthority = 1 - smoothstep((-bankLeft - 0.61) / 0.26);
      }
      node.rotate(
        AXIS_BACK,
        this.rollInput * ROLL_RATE * effectiveness * rollAuthority * dt,
        Space.LOCAL,
      );
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

    // Hands-off roll: ease back toward wings-level. Gain is gentle on
    // purpose: at 0.45 the bank (and with it the turn) died within a
    // couple of seconds of releasing the key — found by live testing.
    // 0.22 keeps a tapped bank turning for several seconds while still
    // self-levelling eventually.
    if (Math.abs(this.rollInput) < 0.15) {
      const rollAngle = Math.asin(clamp(this._right.y, -1, 1));
      node.rotate(AXIS_BACK, -rollAngle * 0.22 * stability * dt, Space.LOCAL);
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

    // Pitch trim — a SPEED trim, like a real elevator trim tab. The
    // target AoA is the greater of:
    //   (a) a fixed trim AoA (~6.6 deg, level flight at ~42 m/s), and
    //   (b) the AoA needed to hold altitude at the current speed
    //       under the bank load factor 1/cos(bank).
    // Trimming to a fixed AoA gives speed stability: faster than trim
    // speed -> excess lift curves the path up and speed bleeds back;
    // slower -> a gentle descent. (Evaluating (b) alone at the
    // *current* speed was tried first: the target shrank as speed
    // rose, so a hands-off "cruise" settled into a permanent shallow
    // dive at ~70 m/s and flew into the ground — see the headless
    // cruise trace.) In a bank, term (b) adds exactly the
    // back-pressure a pilot would apply, so turns hold altitude.
    // The restoring rate is a firm spring (gain 2.0, cap 0.9 rad/s):
    // capped-gentle versions lost a fight against the pilot's pitch
    // rate and let a held climb mush into the stall. Nose-down
    // authority is NOT faded by the stall — that is what breaks the
    // stall even with the stick held back, as in a real aircraft.
    const alphaRad = (alphaDeg * Math.PI) / 180;
    const dynamicPressure = 0.5 * AIR_DENSITY * speed * speed;
    const clLevel = (MASS * GRAVITY) / Math.max(dynamicPressure * WING_AREA, 1);
    const bankCos = Math.max(Math.cos(bankRight), 0.6); // load factor cap ~1.67
    const alphaForLoad = clLevel / bankCos / CL_ALPHA;
    const alphaTarget = clamp(Math.max(TRIM_ALPHA, alphaForLoad), -0.02, 0.19);
    let pitchRate = clamp(2.0 * (alphaTarget - alphaRad), -0.9, 0.9);
    if (pitchRate > 0) pitchRate *= stability; // only nose-up fades in a stall
    node.rotate(AXIS_RIGHT, pitchRate * dt, Space.LOCAL);
  }

  /**
   * Judge a touchdown at the moment of contact (Phase 7): sink rate,
   * attitude, surface and slope decide between a smooth landing, a
   * hard/off-runway arrival, and a crash. Ordinary safe landings sit
   * far inside these limits — the crash lines are structural, not
   * "slightly firm" lines.
   */
  private evaluateTouchdown(ground: GroundInfo, vy: number, speed: number): void {
    this.computeBasis();
    const pitchDeg = Math.asin(clamp(this._forward.y, -1, 1)) * (180 / Math.PI);
    const rollDeg = -Math.asin(clamp(this._right.y, -1, 1)) * (180 / Math.PI);
    const sink = -vy;
    if (ground.surface === "water") {
      this.registerCrash("Ditched in the water");
      return;
    }
    if (sink > SINK_CRASH) {
      this.registerCrash("Impact too hard — high sink rate");
      return;
    }
    if (Math.abs(rollDeg) > ROLL_CRASH_DEG) {
      this.registerCrash("Wing strike — too much bank at touchdown");
      return;
    }
    if (pitchDeg < PITCH_CRASH_DEG) {
      this.registerCrash("Nose-first impact");
      return;
    }
    if (ground.surface === "terrain" && ground.slopeDeg > TERRAIN_SLOPE_CRASH_DEG) {
      this.registerCrash("Terrain impact — steep slope");
      return;
    }
    if (ground.surface === "terrain" && speed > TERRAIN_SPEED_CRASH) {
      this.registerCrash("Too fast for rough ground");
      return;
    }
    const quality: TouchdownInfo["quality"] = ground.onRunway
      ? sink <= SINK_SMOOTH
        ? "smooth"
        : "hard"
      : sink <= SINK_SMOOTH
        ? "off-runway"
        : "hard";
    this.touchdownSeq += 1;
    this.lastTouchdown = {
      quality,
      surface: ground.surface,
      verticalSpeed: vy,
      sequence: this.touchdownSeq,
    };
  }

  /** Latch the crashed state: motion stops, controls go dead. */
  private registerCrash(reason: string): void {
    this.crashed = true;
    this.crashReason = reason;
    this.velocity.set(0, 0, 0);
    this.throttle = 0;
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
      phase: this.crashed ? "crashed" : this.grounded ? "ground" : "air",
      onRunway: this.lastGround.onRunway,
      surface: this.lastGround.surface,
      heightAboveGround: Math.max(
        0,
        this.aircraft.position.y - (this.lastGround.height + GEAR_DEPTH),
      ),
      posX: this.aircraft.position.x,
      posZ: this.aircraft.position.z,
      crashed: this.crashed,
      crashReason: this.crashReason,
      touchdown: this.lastTouchdown,
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
