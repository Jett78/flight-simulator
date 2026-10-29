/**
 * Headless Phase 7 tests: runway interaction, touchdowns, crashes.
 * Runs the REAL AircraftController with the REAL island ground
 * sampler (runway.ts) on Babylon's NullEngine — including a small
 * closed-loop autopilot that flies an actual circuit and lands.
 * Run with: npx tsx test-headless/ground.test.ts
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { AircraftController } from "../src/game/AircraftController";
import type { InputManager } from "../src/game/InputManager";
import { createGroundSampler } from "../src/game/runway";

const DT = 1 / 120;
const START = new Vector3(0, 2.41, 68);

class FakeInput {
  keys = new Set<string>();
  isDown(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }
  wasJustPressed(): boolean {
    return false;
  }
  postUpdate(): void {}
}

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!ok) failures++;
}

function makeSim() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const node = new TransformNode("airplane", scene);
  node.position.copyFrom(START);
  const input = new FakeInput();
  const controller = new AircraftController(node, START, createGroundSampler());
  const step = (keys: string[]) => {
    input.keys = new Set(keys);
    controller.step(DT, input as unknown as InputManager);
  };
  const run = (seconds: number, keys: string[] = []) => {
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) step(keys);
  };
  return { controller, node, step, run };
}

const wrapDeg = (d: number) => (d < -180 ? d + 360 : d > 180 ? d - 360 : d);

/**
 * A tiny closed-loop pilot. Each step it steers toward a target
 * point (bank toward the bearing), manages vertical speed with
 * pitch, and works the SPRING throttle with a latched band: power
 * stays on until the speed cap is exceeded, then stays off until
 * speed falls back — releasing the key is how this throttle slows
 * down, exactly as in the real controls.
 */
type PilotMode = "climb" | "cruise" | "final";
const pilotLatch = new WeakMap<object, boolean>();

function pilotStep(
  sim: ReturnType<typeof makeSim>,
  target: { x: number; z: number } | null,
  targetVS: number,
  mode: PilotMode,
) {
  const s = sim.controller.getState();
  const keys = new Set<string>();
  const cap = mode === "climb" ? 99 : mode === "cruise" ? 40 : 31;
  let powerOn = pilotLatch.get(sim) ?? true;
  if (s.airspeed > cap + 3) powerOn = false;
  if (s.airspeed < cap - 3) powerOn = true;
  if (mode === "climb") powerOn = true;
  pilotLatch.set(sim, powerOn);
  if (powerOn) keys.add("ShiftLeft");
  // Steering (airborne only): bank toward the target bearing.
  if (target && !s.grounded) {
    const bearing =
      (Math.atan2(target.x - s.posX, -(target.z - s.posZ)) * 180) / Math.PI;
    const err = wrapDeg(bearing - s.headingDeg);
    if (err > 4) keys.add("KeyD");
    else if (err < -4) keys.add("KeyA");
  }
  // Pitch toward the target vertical speed.
  if (!s.grounded || s.airspeed > 27) {
    if (s.verticalSpeed < targetVS - 0.4) keys.add("KeyS");
    else if (s.verticalSpeed > targetVS + 0.4) keys.add("KeyW");
  }
  sim.step([...keys]);
}

/** Take off and climb to a settled cruise at ~110 m (above the low hills). */
function takeoffAndClimb(sim: ReturnType<typeof makeSim>) {
  let t = 0;
  while (t < 90) {
    const s = sim.controller.getState();
    if (s.grounded) {
      if (s.airspeed > 27) sim.step(["ShiftLeft", "KeyS"]); // rotate
      else sim.step(["ShiftLeft"]);
    } else if (s.altitude < 110) {
      pilotStep(sim, null, 4, "climb");
    } else {
      return;
    }
    t += DT;
  }
  throw new Error("takeoff/climb timed out");
}

// ---------- G1. Spawn: on the runway, phase = ground ----------
{
  const { controller } = makeSim();
  const s = controller.getState();
  check(
    "spawn on runway",
    s.grounded && s.onRunway && s.phase === "ground" && s.surface === "runway" && !s.crashed,
    `phase=${s.phase} surface=${s.surface} onRunway=${s.onRunway}`,
  );
}

// ---------- G2. Takeoff: phase transitions, liftoff over the runway ----------
{
  const sim = makeSim();
  takeoffAndClimb(sim);
  const s = sim.controller.getState();
  check(
    "takeoff to airborne cruise",
    s.phase === "air" && !s.grounded && s.altitude > 50 && s.touchdown === null,
    `phase=${s.phase} alt=${s.altitude.toFixed(0)}m`,
  );
}


const clampNum = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Heading-hold step: bank toward a desired heading (with the same
 * throttle latch and VS pitch loop as pilotStep). Real approaches
 * are flown as tracks, not point pursuit — this converges onto a
 * ground track by construction.
 */
function headingStep(
  sim: ReturnType<typeof makeSim>,
  desiredHeadingDeg: number,
  targetVS: number,
  mode: PilotMode,
  vsDeadband = 0.4,
  hdgDeadband = 3,
) {
  const s = sim.controller.getState();
  const keys = new Set<string>();
  const cap = mode === "climb" ? 99 : mode === "cruise" ? 40 : 31;
  let powerOn = pilotLatch.get(sim) ?? true;
  if (s.airspeed > cap + 3) powerOn = false;
  if (s.airspeed < cap - 3) powerOn = true;
  if (mode === "climb") powerOn = true;
  pilotLatch.set(sim, powerOn);
  if (powerOn) keys.add("ShiftLeft");
  if (!s.grounded) {
    const err = wrapDeg(desiredHeadingDeg - s.headingDeg);
    if (err > hdgDeadband) keys.add("KeyD");
    else if (err < -hdgDeadband) keys.add("KeyA");
  }
  if (!s.grounded || s.airspeed > 27) {
    if (s.verticalSpeed < targetVS - vsDeadband) keys.add("KeyS");
    else if (s.verticalSpeed > targetVS + vsDeadband) keys.add("KeyW");
  }
  sim.step([...keys]);
}

/**
 * Fly a rectangular circuit and land: downwind leg southbound on an
 * offset track, a turn back north, then a long straight final with
 * continuous lateral correction onto the target track, descending
 * on a ~5.5-degree glide with a flare. Returns true if the aircraft
 * overflew the runway airborne without a false touchdown on the way.
 */
function flyCircuit(
  sim: ReturnType<typeof makeSim>,
  opts: { downwindX: number; finalX: number },
) {
  let overflewClean = false;
  const note = () => {
    const s = sim.controller.getState();
    if (s.onRunway && !s.grounded && s.touchdown === null) overflewClean = true;
  };
  // Downwind: southbound, correct onto the offset track, until z >= 1250.
  let t = 0;
  while (t < 240) {
    const s = sim.controller.getState();
    if (s.crashed) return overflewClean;
    if (s.posZ >= 1250) break;
    const desired = 180 + clampNum(0.08 * (s.posX - opts.downwindX), -25, 25);
    headingStep(sim, desired, 0, "cruise");
    note();
    t += DT;
  }
  // Turn back north and re-establish, correcting onto the final track.
  t = 0;
  while (t < 240) {
    const s = sim.controller.getState();
    if (s.crashed) return overflewClean;
    const err = Math.abs(wrapDeg(0 - s.headingDeg));
    if (err < 15 && s.posZ < 1100 && Math.abs(s.posX - opts.finalX) < 60) break;
    const desired = -clampNum(0.08 * (s.posX - opts.finalX), -25, 25);
    headingStep(sim, desired, 0, "cruise");
    note();
    t += DT;
  }
  // Final: proportional glide to the aim point (steepens if floating
  // long, shallows if short), still correcting laterally.
  const aimZ = 10;
  t = 0;
  while (t < 300) {
    const s = sim.controller.getState();
    if (s.grounded || s.crashed) break;
    const dist = Math.max(Math.hypot(s.posX - opts.finalX, s.posZ - aimZ), 80);
    let targetVS = clampNum(
      (-s.heightAboveGround * Math.max(s.airspeed, 25)) / dist,
      -3.8,
      -1.4,
    );
    if (s.heightAboveGround < 2.5) targetVS = Math.max(targetVS, -1.0);
    // Low on final: corrections get gentler, and below 8 m the
    // heading is held so the wings are level for the touchdown.
    const gain = s.heightAboveGround < 20 ? 0.05 : 0.1;
    const cap = s.heightAboveGround < 20 ? 9 : 14;
    const desired =
      s.heightAboveGround < 8
        ? s.headingDeg
        : -clampNum(gain * (s.posX - opts.finalX), -cap, cap);
    headingStep(sim, desired, targetVS, "final", 0.2, 1.5);
    note();
    t += DT;
  }
  return overflewClean;
}


/**
 * Place the aircraft on a stabilized final approach: airborne,
 * wings level, heading -Z (runway heading), at the given position
 * and speed. Skips the error-prone circuit so the LANDING SYSTEM
 * (touchdown evaluation, ground contact, rollout) is tested
 * deterministically; the full circuit is flown separately in G3b.
 */
function placeOnFinal(
  sim: ReturnType<typeof makeSim>,
  x: number,
  y: number,
  z: number,
  speed: number,
  vs: number,
  throttle: number,
) {
  sim.controller.reset();
  sim.node.position.set(x, y, z);
  sim.controller.velocity.set(0, vs, -speed);
  sim.controller.throttle = throttle;
  sim.controller.grounded = false;
}

/** Short-final pilot: heading-hold with lateral correction + proportional glide. */
function flyFinal(
  sim: ReturnType<typeof makeSim>,
  finalX: number,
  aimZ: number,
) {
  let t = 0;
  while (t < 180) {
    const s = sim.controller.getState();
    if (s.grounded || s.crashed) break;
    const dist = Math.max(Math.hypot(s.posX - finalX, s.posZ - aimZ), 80);
    let targetVS = clampNum(
      (-s.heightAboveGround * Math.max(s.airspeed, 25)) / dist,
      -3.8,
      -1.4,
    );
    if (s.heightAboveGround < 2.5) targetVS = Math.max(targetVS, -1.0);
    const gain = s.heightAboveGround < 20 ? 0.05 : 0.1;
    const cap = s.heightAboveGround < 20 ? 9 : 14;
    const desired =
      s.heightAboveGround < 8
        ? s.headingDeg
        : -clampNum(gain * (s.posX - finalX), -cap, cap);
    headingStep(sim, desired, targetVS, "final", 0.2, 1.5);
    t += DT;
  }
}

// ---------- G3. Safe landing on the runway (stabilized final) ----------
{
  const sim = makeSim();
  placeOnFinal(sim, 0, 55, 850, 33, -1, 0.75);
  flyFinal(sim, 0, 10);
  const s = sim.controller.getState();
  check(
    "safe landing on the runway",
    s.grounded && !s.crashed && s.touchdown !== null && s.touchdown.quality === "smooth" && s.touchdown.surface === "runway",
    `touchdown=${JSON.stringify(s.touchdown)} crashed=${s.crashed} reason="${s.crashReason}" at (${s.posX.toFixed(0)}, ${s.posZ.toFixed(0)})`,
  );
  // Roll out to a stop with the engine idling down.
  sim.run(45, []);
  const s2 = sim.controller.getState();
  check(
    "rolls out and stops without crashing",
    s2.grounded && !s2.crashed && s2.airspeed < 0.5,
    `v=${s2.airspeed.toFixed(1)} at (${s2.posX.toFixed(0)}, ${s2.posZ.toFixed(0)})`,
  );
}

// ---------- G3b. Full circuit from takeoff ends in a safe landing ----------
{
  const sim = makeSim();
  takeoffAndClimb(sim);
  const overflewRunwayClean = flyCircuit(sim, { downwindX: 350, finalX: 0 });
  const s = sim.controller.getState();
  check(
    "full circuit lands safely near the runway",
    s.grounded && !s.crashed && s.touchdown !== null && Math.abs(s.posX) < 80,
    `touchdown=${JSON.stringify(s.touchdown)} crashed=${s.crashed} at (${s.posX.toFixed(0)}, ${s.posZ.toFixed(0)})`,
  );
  check(
    "no false touchdown while overflying the runway",
    overflewRunwayClean,
    "airborne over the asphalt recorded no touchdown",
  );
}

// ---------- G4. Off-runway landing on the grass pad ----------
{
  const sim = makeSim();
  placeOnFinal(sim, 60, 55, 850, 33, -1, 0.75);
  flyFinal(sim, 60, 10);
  const s = sim.controller.getState();
  check(
    "off-runway landing survives on grass",
    s.grounded && !s.crashed && s.touchdown !== null && s.touchdown.quality === "off-runway" && s.touchdown.surface === "terrain",
    `touchdown=${JSON.stringify(s.touchdown)} crashed=${s.crashed} reason="${s.crashReason}" at (${s.posX.toFixed(0)}, ${s.posZ.toFixed(0)})`,
  );
}

// ---------- G5. Hard landing: firm sink, survives ----------
{
  const sim = makeSim();
  // Stabilized on final at 18 m over the pad, idle, sinking -3.5:
  // hold about -4.2 m/s to the ground for a firm but safe arrival.
  placeOnFinal(sim, 0, 20.25, 260, 38, -3.5, 0);
  let t = 0;
  let landed = false;
  while (t < 60) {
    const s = sim.controller.getState();
    if (s.grounded) {
      landed = true;
      break;
    }
    if (s.crashed) break;
    const keys: string[] = [];
    if (s.heightAboveGround > 8) {
      if (s.verticalSpeed > -3.9) keys.push("KeyW");
      else if (s.verticalSpeed < -4.5) keys.push("KeyS");
    }
    sim.step(keys);
    t += DT;
  }
  const s = sim.controller.getState();
  check(
    "hard landing survives",
    landed && !s.crashed && s.touchdown !== null && s.touchdown.quality === "hard",
    `touchdown=${JSON.stringify(s.touchdown)} crashed=${s.crashed} reason="${s.crashReason}" at (${s.posX.toFixed(0)}, ${s.posZ.toFixed(0)})`,
  );
}

// ---------- G6. Crash: fly into the peak, freeze, reset ----------
{
  const sim = makeSim();
  takeoffAndClimb(sim);
  let t = 0;
  while (t < 240 && !sim.controller.getState().crashed) {
    const s = sim.controller.getState();
    if (s.grounded) break;
    const distToPeak = Math.hypot(620 - s.posX, -430 - s.posZ);
    const targetVS = distToPeak < 480 ? (s.altitude > 42 ? -1.5 : 0) : 0;
    pilotStep(sim, { x: 620, z: -430 }, targetVS, "cruise");
    t += DT;
  }
  const s = sim.controller.getState();
  check("terrain impact crashes", s.crashed && s.phase === "crashed", `reason="${s.crashReason}"`);
  const px = s.posX;
  const pz = s.posZ;
  sim.run(2, ["ShiftLeft", "KeyS"]); // controls must be dead
  const s2 = sim.controller.getState();
  check(
    "crashed aircraft is frozen",
    s2.crashed && s2.airspeed === 0 && Math.abs(s2.posX - px) < 0.01 && Math.abs(s2.posZ - pz) < 0.01,
    `v=${s2.airspeed} drift=(${Math.abs(s2.posX - px).toFixed(2)}, ${Math.abs(s2.posZ - pz).toFixed(2)})`,
  );
  sim.controller.reset();
  const s3 = sim.controller.getState();
  check(
    "reset after crash restores the start",
    !s3.crashed && s3.grounded && s3.onRunway && s3.airspeed === 0 && s3.altitude === 0,
    `phase=${s3.phase} onRunway=${s3.onRunway}`,
  );
}

// ---------- G7. Terrain impact: fly into the big NE peak ----------
{
  const sim = makeSim();
  takeoffAndClimb(sim);
  // Cruise high, then descend to ~42 m datum on a heading for the peak.
  let t = 0;
  let done = false;
  while (t < 240) {
    const s = sim.controller.getState();
    if (s.crashed || s.grounded) {
      done = true;
      break;
    }
    const distToPeak = Math.hypot(620 - s.posX, -430 - s.posZ);
    const targetVS = distToPeak < 480 ? (s.altitude > 42 ? -1.5 : 0) : 0;
    pilotStep(sim, { x: 620, z: -430 }, targetVS, "cruise");
    t += DT;
  }
  const s = sim.controller.getState();
  check(
    "flying into the hillside crashes",
    done && s.crashed,
    `crashed=${s.crashed} reason="${s.crashReason}" at (${s.posX.toFixed(0)}, ${s.posZ.toFixed(0)}) alt=${s.altitude.toFixed(0)}`,
  );
}

// ---------- G8. Ditching: descend into the sea north of the island ----------
{
  const sim = makeSim();
  takeoffAndClimb(sim);
  // Powered flight north until past the coast, then glide down.
  let t = 0;
  while (t < 120 && sim.controller.getState().posZ > -1000) {
    pilotStep(sim, { x: 0, z: -3000 }, 0, "climb");
    t += DT;
  }
  t = 0;
  let done = false;
  while (t < 300) {
    const s = sim.controller.getState();
    if (s.crashed || s.grounded) {
      done = true;
      break;
    }
    pilotStep(sim, { x: 0, z: -3000 }, -2.5, "final");
    t += DT;
  }
  const s = sim.controller.getState();
  check(
    "descending into the sea is a ditching crash",
    done && s.crashed && s.surface === "water",
    `crashed=${s.crashed} surface=${s.surface} reason="${s.crashReason}" at (${s.posX.toFixed(0)}, ${s.posZ.toFixed(0)})`,
  );
}

console.log(failures === 0 ? "\nALL GROUND TESTS PASSED" : `\n${failures} GROUND TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
