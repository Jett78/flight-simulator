import { Space } from "@babylonjs/core/Maths/math.axis";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { InputManager } from "./InputManager";

/**
 * Basic aircraft movement (Phase 3) — deliberately NOT an aerodynamic
 * model. The aircraft flies exactly where its nose points, at a speed
 * driven by the throttle. All updates take a delta-time in seconds and
 * are frame-rate independent.
 *
 * Control conventions (documented, consistent everywhere):
 *   forward = -Z, up = +Y, right = +X
 *   W = nose down,  S = nose up        (yoke/stick style: push = descend)
 *   A = bank left,  D = bank right
 *   Q = yaw left,   E = yaw right
 *   Shift = throttle up, Ctrl = throttle down
 *
 * Rotation signs below come straight from the right-hand rule on the
 * local axes: +rotation about +X lifts the nose (-Z gains +Y), +rotation
 * about +Z lifts the right wing (bank left), +rotation about +Y swings
 * the nose toward -X (yaw left).
 */

const MAX_SPEED = 85; // m/s at full throttle (~306 km/h)
const THROTTLE_RATE = 0.45; // throttle units per second while Shift/Ctrl held
const ACCELERATION = 13; // m/s^2 the speed may chase its target with
const PITCH_RATE = 0.85; // rad/s at full deflection
const ROLL_RATE = 1.7; // rad/s at full deflection
const YAW_RATE = 0.55; // rad/s at full deflection
const INPUT_RESPONSE = 7; // 1/s — smoothing of control deflections
const GROUND_Y = 2.41; // root height when the wheels rest on the runway
const CEILING_Y = 500;

const AXIS_RIGHT = new Vector3(1, 0, 0);
const AXIS_UP = new Vector3(0, 1, 0);
const AXIS_BACK = new Vector3(0, 0, 1);
const LOCAL_FORWARD = new Vector3(0, 0, -1);

/** Exponential approach of `current` toward `target`, dt-correct. */
function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export class AircraftController {
  private readonly aircraft: TransformNode;
  private readonly startPosition: Vector3;

  /** 0..1 throttle setting (Shift/Ctrl). */
  throttle = 0;
  /** Current forward speed in m/s. */
  speed = 0;

  // Smoothed control deflections, each -1..1
  private pitchInput = 0;
  private rollInput = 0;
  private yawInput = 0;

  // Scratch objects (no per-frame allocation)
  private readonly _matrix = new Matrix();
  private readonly _forward = new Vector3();

  constructor(aircraft: TransformNode, startPosition: Vector3) {
    this.aircraft = aircraft;
    this.startPosition = startPosition.clone();
    this.reset();
  }

  /** Restore the exact initial state: position, level orientation,
   *  zero speed and throttle, centred controls. */
  reset(): void {
    this.aircraft.position.copyFrom(this.startPosition);
    if (!this.aircraft.rotationQuaternion) {
      this.aircraft.rotationQuaternion = new Quaternion();
    }
    this.aircraft.rotationQuaternion.copyFromFloats(0, 0, 0, 1);
    this.aircraft.rotation.set(0, 0, 0);
    this.throttle = 0;
    this.speed = 0;
    this.pitchInput = 0;
    this.rollInput = 0;
    this.yawInput = 0;
  }

  update(dt: number, input: InputManager): void {
    if (dt <= 0) return;
    const node = this.aircraft;

    // --- Throttle & speed ---
    if (input.isDown("ShiftLeft", "ShiftRight")) {
      this.throttle = Math.min(1, this.throttle + THROTTLE_RATE * dt);
    }
    if (input.isDown("ControlLeft", "ControlRight")) {
      this.throttle = Math.max(0, this.throttle - THROTTLE_RATE * dt);
    }
    const targetSpeed = this.throttle * MAX_SPEED;
    const maxDelta = ACCELERATION * dt;
    this.speed += Math.max(-maxDelta, Math.min(maxDelta, targetSpeed - this.speed));

    // --- Smoothed control deflections ---
    const pitchTarget = (input.isDown("KeyS") ? 1 : 0) + (input.isDown("KeyW") ? -1 : 0);
    const rollTarget = (input.isDown("KeyA") ? 1 : 0) + (input.isDown("KeyD") ? -1 : 0);
    const yawTarget = (input.isDown("KeyQ") ? 1 : 0) + (input.isDown("KeyE") ? -1 : 0);
    this.pitchInput = damp(this.pitchInput, pitchTarget, INPUT_RESPONSE, dt);
    this.rollInput = damp(this.rollInput, rollTarget, INPUT_RESPONSE, dt);
    this.yawInput = damp(this.yawInput, yawTarget, INPUT_RESPONSE, dt);

    // --- Rotation (local space) ---
    // Ground guard: while the wheels are on the ground, don't let pitch
    // push the nose below level and don't roll (wings would clip the
    // runway). Yaw still works, like nose-wheel steering.
    const grounded = node.position.y <= GROUND_Y + 0.01;
    this.computeForward();
    if (this.pitchInput !== 0 && !(grounded && this.pitchInput < 0 && this._forward.y <= 0.001)) {
      node.rotate(AXIS_RIGHT, this.pitchInput * PITCH_RATE * dt, Space.LOCAL);
    }
    if (this.rollInput !== 0 && !grounded) {
      node.rotate(AXIS_BACK, this.rollInput * ROLL_RATE * dt, Space.LOCAL);
    }
    if (this.yawInput !== 0) {
      node.rotate(AXIS_UP, this.yawInput * YAW_RATE * dt, Space.LOCAL);
    }

    // --- Translation: move along the nose direction at current speed ---
    if (this.speed !== 0) {
      this.computeForward();
      node.position.addInPlace(this._forward.scale(this.speed * dt));
    }

    // World limits: never sink below the runway, never leave the sky
    if (node.position.y < GROUND_Y) node.position.y = GROUND_Y;
    if (node.position.y > CEILING_Y) node.position.y = CEILING_Y;
  }

  /** Aircraft nose direction in world space, from its quaternion. */
  private computeForward(): void {
    const q = this.aircraft.rotationQuaternion;
    if (!q) {
      this._forward.copyFrom(LOCAL_FORWARD);
      return;
    }
    Matrix.FromQuaternionToRef(q, this._matrix);
    Vector3.TransformNormalToRef(LOCAL_FORWARD, this._matrix, this._forward);
  }
}
