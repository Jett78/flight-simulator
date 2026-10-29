/**
 * Headless physics self-test for the Phase 4 flight model.
 * Runs the REAL AircraftController on Babylon's NullEngine (no GPU).
 * Run with: npx tsx test-headless/physics.test.ts
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { AircraftController } from "../src/game/AircraftController";
import type { InputManager } from "../src/game/InputManager";

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
  const controller = new AircraftController(node, START);
  const run = (seconds: number, keys: string[] = []) => {
    input.keys = new Set(keys);
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) controller.step(DT, input as unknown as InputManager);
  };
  /** Hold keys until predicate or timeout; returns elapsed seconds. */
  const runUntil = (keys: string[], pred: () => boolean, timeout: number) => {
    input.keys = new Set(keys);
    let t = 0;
    while (!pred() && t < timeout) {
      controller.step(DT, input as unknown as InputManager);
      t += DT;
    }
    return t;
  };
  return { controller, node, run, runUntil, input };
}

// ---------- 1. Idle: nothing moves without throttle ----------
{
  const { controller, run } = makeSim();
  run(3);
  const s = controller.getState();
  check("idle stays parked", s.airspeed < 0.01 && s.altitude === 0, `v=${s.airspeed.toFixed(2)} alt=${s.altitude}`);
}

// ---------- 2. Takeoff + climb ----------
{
  const { controller, run, runUntil } = makeSim();
  run(2.5, ["ShiftLeft"]); // throttle to ~100%
  const tRoll = runUntil(["ShiftLeft"], () => controller.getState().airspeed >= 33, 30);
  const sRoll = controller.getState();
  check(
    "accelerates on ground roll",
    sRoll.airspeed >= 33 && sRoll.grounded,
    `reached 33 m/s in ${tRoll.toFixed(1)}s, grounded=${sRoll.grounded}`,
  );
  // Rotate: hold S (nose up) while still holding Shift (spring throttle)
  runUntil(["ShiftLeft", "KeyS"], () => controller.getState().altitude > 3, 12);
  const sAir = controller.getState();
  check("takes off after rotation", !sAir.grounded && sAir.altitude > 3, `alt=${sAir.altitude.toFixed(1)}m v=${sAir.airspeed.toFixed(1)}`);
  run(4, ["ShiftLeft"]); // hands off the stick (throttle held), should keep climbing
  const sClimb = controller.getState();
  check("climbs / sustains flight", sClimb.altitude > 8, `alt=${sClimb.altitude.toFixed(1)}m VS=${sClimb.verticalSpeed.toFixed(1)}`);
  (globalThis as { __sim2?: unknown }).__sim2 = { controller, run, runUntil };
}

// ---------- 3. Banked turn (continues sim 2's aircraft) ----------
{
  const { controller, run, runUntil } = (globalThis as { __sim2: ReturnType<typeof makeSim> }).__sim2;
  runUntil(["ShiftLeft"], () => controller.getState().altitude > 45 && controller.getState().airspeed >= 32, 40); // settle into cruise first
  run(1, ["ShiftLeft"]);
  const h0 = controller.getState().headingDeg;
  run(0.45, ["ShiftLeft", "KeyD"]); // bank right (~25-30 degrees)
  const banked = controller.getState();
  run(6, ["ShiftLeft"]); // let the turn develop under lift + stability
  const h1 = controller.getState().headingDeg;
  let dh = h1 - h0;
  if (dh < -180) dh += 360;
  if (dh > 180) dh -= 360;
  check(
    "bank produces a turn",
    Math.abs(banked.rollDeg) > 12 && dh > 10,
    `roll during bank=${banked.rollDeg.toFixed(0)}°, heading change=${dh.toFixed(0)}°`,
  );
}

// ---------- 3b. Tapped bank still turns (live-test scenario) ----------
// The browser test harness (and many players) tap keys instead of
// holding them. A 0.15 s tap must still produce a visible turn that
// persists for several seconds hands-off (auto-level must not kill it
// instantly). Regression test for the weak live bank turn.
{
  const { controller, run, runUntil } = makeSim();
  run(2.5, ["ShiftLeft"]);
  runUntil(["ShiftLeft"], () => controller.getState().airspeed >= 33, 30);
  runUntil(["ShiftLeft", "KeyS"], () => controller.getState().altitude > 6, 12);
  runUntil(["ShiftLeft"], () => controller.getState().altitude >= 40 && controller.getState().airspeed >= 32, 40);
  run(1, ["ShiftLeft"]);
  const h0 = controller.getState().headingDeg;
  run(0.15, ["ShiftLeft", "KeyD"]); // a tap, not a hold
  run(5, ["ShiftLeft"]);
  const h1 = controller.getState().headingDeg;
  let dh = h1 - h0;
  if (dh < -180) dh += 360;
  if (dh > 180) dh -= 360;
  check("tapped bank produces a visible turn", dh > 5, `heading change after tap=${dh.toFixed(1)}°`);
}

// ---------- 3c. Compensated banked turn holds altitude ----------
// Regression test for the live-test finding: an uncompensated banked
// turn sank at ~8 m/s and touched down. With alpha-trim turn
// compensation, a moderate hands-off turn must roughly hold altitude.
{
  const { controller, run, runUntil } = makeSim();
  run(2.5, ["ShiftLeft"]);
  runUntil(["ShiftLeft"], () => controller.getState().airspeed >= 33, 30);
  runUntil(["ShiftLeft", "KeyS"], () => controller.getState().altitude > 6, 12);
  runUntil(["ShiftLeft"], () => controller.getState().altitude >= 55 && controller.getState().airspeed >= 32, 45);
  run(1.5, ["ShiftLeft"]);
  const before = controller.getState();
  run(0.7, ["ShiftLeft", "KeyD"]); // build a moderate bank
  run(6, ["ShiftLeft"]); // hands-off turn
  const after = controller.getState();
  let dh = after.headingDeg - before.headingDeg;
  if (dh < -180) dh += 360;
  if (dh > 180) dh -= 360;
  check(
    "banked turn holds altitude (compensation)",
    dh > 12 && before.altitude - after.altitude < 10 && !after.grounded,
    `heading +${dh.toFixed(0)}°, alt ${before.altitude.toFixed(0)}m -> ${after.altitude.toFixed(0)}m`,
  );
}

// ---------- 3d. High-speed banked turn (the actual live failure) ----------
// Live trial: at 227-260 km/h a bank sank at ~8 m/s and touched down.
// Replicate: build speed in a shallow dive, then turn hands-off.
{
  const { controller, run, runUntil } = makeSim();
  run(2.5, ["ShiftLeft"]);
  runUntil(["ShiftLeft"], () => controller.getState().airspeed >= 33, 30);
  runUntil(["ShiftLeft", "KeyS"], () => controller.getState().altitude > 6, 12);
  runUntil(["ShiftLeft"], () => controller.getState().altitude >= 160 && controller.getState().airspeed >= 32, 60);
  // Build speed in a dive, level out, and bank promptly (speed bleeds
  // back toward trim speed over ~20 s, so don't wait). This mirrors
  // the live scenario: fast shallow flight at 200+ km/h.
  runUntil(["ShiftLeft", "KeyW"], () => controller.getState().airspeed >= 57 || controller.getState().altitude < 110, 12);
  runUntil(["ShiftLeft", "KeyS"], () => controller.getState().verticalSpeed >= -2, 6);
  run(0.3, ["ShiftLeft"]);
  const before = controller.getState();
  run(0.7, ["ShiftLeft", "KeyD"]);
  run(6, ["ShiftLeft"]);
  const after = controller.getState();
  let dh = after.headingDeg - before.headingDeg;
  if (dh < -180) dh += 360;
  if (dh > 180) dh -= 360;
  check(
    "high-speed banked turn does not sink",
    before.airspeed > 48 &&
      before.altitude > 40 &&
      dh > 10 &&
      before.altitude - after.altitude < 12 &&
      !after.grounded,
    `v=${before.airspeed.toFixed(0)}m/s (${(before.airspeed * 3.6).toFixed(0)} km/h), heading +${dh.toFixed(0)}°, alt ${before.altitude.toFixed(0)}m -> ${after.altitude.toFixed(0)}m`,
  );
}

// ---------- 4. Stall + recovery ----------
{
  const { controller, run, runUntil } = makeSim();
  run(2.5, ["ShiftLeft"]);
  runUntil(["ShiftLeft"], () => controller.getState().airspeed >= 33, 30);
  runUntil(["ShiftLeft", "KeyS"], () => controller.getState().altitude > 6, 12);
  runUntil(["ShiftLeft"], () => controller.getState().altitude >= 80 && controller.getState().airspeed >= 32, 45);
  run(1.5, ["ShiftLeft"]); // settle in climb attitude hands-off (stall entry needs altitude in hand)
  // Kill the throttle and hold the nose up hard -> stall
  run(2.5, ["ControlLeft"]); // throttle -> 0
  let maxStall = 0;
  let minVS = 0;
  const input = { keys: new Set(["KeyS"]) };
  void input;
  const t0 = 14;
  for (let t = 0; t < t0; t += DT) {
    // hold S the whole time
    run(DT, ["KeyS"]);
    const s = controller.getState();
    maxStall = Math.max(maxStall, s.stallFactor);
    if (s.stallFactor > 0.3) minVS = Math.min(minVS, s.verticalSpeed);
    if (maxStall > 0.5 && s.verticalSpeed < -3) break;
  }
  const sStall = controller.getState();
  check(
    "stalls when slow + nose high",
    maxStall > 0.4,
    `max stallFactor=${maxStall.toFixed(2)} AoA=${sStall.angleOfAttackDeg.toFixed(0)}° v=${sStall.airspeed.toFixed(1)} VS=${sStall.verticalSpeed.toFixed(1)}`,
  );
  check("loses lift / descends in stall", minVS < -2 || sStall.verticalSpeed < -2, `VS in stall=${Math.min(minVS, sStall.verticalSpeed).toFixed(1)} m/s`);
  // Recover with real technique (holding full nose-down for 8s dives
  // into the ground in any flight model — verified during tuning):
  // throttle up, W only until the stall breaks, brief S pull-out,
  // then hands off and let stability settle it.
  runUntil(["ShiftLeft", "KeyW"], () => controller.getState().stallFactor < 0.05, 3);
  run(1.2, ["ShiftLeft", "KeyS"]);
  run(5, ["ShiftLeft"]);
  const sRec = controller.getState();
  check(
    "recovers from stall",
    sRec.stallFactor < 0.2 && sRec.airspeed > 32 && sRec.altitude > 2,
    `stall=${sRec.stallFactor.toFixed(2)} v=${sRec.airspeed.toFixed(1)} alt=${sRec.altitude.toFixed(0)}`,
  );
  // Reset
  controller.reset();
  const sReset = controller.getState();
  check(
    "reset restores start state",
    sReset.airspeed === 0 && sReset.throttle === 0 && sReset.altitude === 0 && sReset.grounded,
    `v=${sReset.airspeed} thr=${sReset.throttle} alt=${sReset.altitude}`,
  );
}

// ---------- 5. Descent on throttle cut (no stall) ----------
{
  const { controller, run, runUntil } = makeSim();
  run(2.5, ["ShiftLeft"]);
  runUntil(["ShiftLeft"], () => controller.getState().airspeed >= 33, 30);
  runUntil(["ShiftLeft", "KeyS"], () => controller.getState().altitude > 6, 12);
  runUntil(["ShiftLeft"], () => controller.getState().altitude >= 30 && controller.getState().airspeed >= 30, 30);
  run(1, ["ShiftLeft"]);
  const altBefore = controller.getState().altitude;
  run(3, ["ControlLeft"]); // throttle to ~0 (2.2s to drain)
  // Idle from a climb attitude first trades speed for height (zoom),
  // then settles into a descent as lift fades — watch long enough.
  run(11, []);
  const s = controller.getState();
  check(
    "descends when lift is insufficient (idle throttle)",
    s.altitude < altBefore - 5 && s.verticalSpeed <= 0.5,
    `alt ${altBefore.toFixed(0)}m -> ${s.altitude.toFixed(0)}m, VS=${s.verticalSpeed.toFixed(1)}`,
  );
}

// ---------- 6. Frame-rate independence (accumulator equivalence) ----------
{
  // Same input timeline stepped two ways: pure 120Hz steps vs an
  // accumulator fed with 1/30s render frames. Step sequences are
  // identical by construction, so end states must match closely.
  const a = makeSim();
  const b = makeSim();
  const timeline = (t: number): string[] => {
    if (t < 2.5) return ["ShiftLeft"];
    if (t < 9) return ["ShiftLeft"];
    if (t < 12) return ["ShiftLeft", "KeyS"];
    return ["ShiftLeft"];
  };
  const total = 16;
  for (let t = 0; t < total; t += DT) a.run(DT, timeline(t));
  let acc = 0;
  const frame = 1 / 30;
  for (let t = 0; t < total; t += frame) {
    acc += frame;
    b.input.keys = new Set(timeline(t));
    while (acc >= DT) {
      b.controller.step(DT, b.input as unknown as InputManager);
      acc -= DT;
    }
  }
  const pa = a.node.position;
  const pb = b.node.position;
  const dist = Vector3.Distance(pa, pb);
  // Tolerance covers input sampling at frame edges (30 Hz sampling of
  // the same timeline), not physics divergence — the point is the two
  // runs fly the same trajectory instead of one blowing up.
  check("physics independent of frame rate", dist < 6, `end-position delta=${dist.toFixed(2)}m after 16s`);
}


// ---------- 7. Spring throttle: release = power drops (Jeet, 2026-10-29) ----------
{
  const { controller, run } = makeSim();
  run(2, ["ShiftLeft"]);
  const thrFull = controller.getState().throttle;
  run(1, []); // release everything: power must fall on its own
  const thrDecay = controller.getState().throttle;
  run(1.2, []);
  const thrZero = controller.getState().throttle;
  check(
    "throttle rises holding Shift, decays when released",
    thrFull > 0.95 && thrDecay < 0.65 && thrDecay > 0.25 && thrZero < 0.02,
    `full=${thrFull.toFixed(2)} after 1s released=${thrDecay.toFixed(2)} after 2.2s=${thrZero.toFixed(2)}`,
  );
  run(1.5, ["ShiftLeft"]);
  const thrUp = controller.getState().throttle;
  run(0.5, ["ControlLeft"]); // Ctrl = fast cut (faster than the decay)
  const thrCut = controller.getState().throttle;
  check(
    "Ctrl cuts throttle faster than decay",
    thrUp > 0.85 && thrCut < thrUp - 0.5,
    `up=${thrUp.toFixed(2)} after 0.5s Ctrl=${thrCut.toFixed(2)}`,
  );
}

// ---------- 8. Liftoff happens well within the runway (Jeet, 2026-10-29) ----------
{
  const { controller, node, runUntil } = makeSim();
  runUntil(["ShiftLeft"], () => controller.getState().airspeed >= 27, 20);
  runUntil(["ShiftLeft", "KeyS"], () => !controller.getState().grounded, 15);
  const s = controller.getState();
  const roll = 68 - node.position.z; // start z=68, runway end at z=-110 (178 m ahead)
  check(
    "liftoff within the runway",
    !s.grounded && roll > 40 && roll <= 130,
    `liftoff after ${roll.toFixed(0)} m of roll at ${(s.airspeed * 3.6).toFixed(0)} km/h (178 m available)`,
  );
}

// ---------- 9. A turns left, D turns right ----------
{
  const settle = () => {
    const sim = makeSim();
    sim.run(2.5, ["ShiftLeft"]);
    sim.runUntil(["ShiftLeft"], () => sim.controller.getState().airspeed >= 33, 30);
    sim.runUntil(["ShiftLeft", "KeyS"], () => sim.controller.getState().altitude > 6, 12);
    sim.runUntil(["ShiftLeft"], () => sim.controller.getState().altitude >= 45 && sim.controller.getState().airspeed >= 32, 40);
    sim.run(1, ["ShiftLeft"]);
    return sim;
  };
  const wrap = (d: number) => (d < -180 ? d + 360 : d > 180 ? d - 360 : d);
  const a = settle();
  const ha0 = a.controller.getState().headingDeg;
  a.run(0.6, ["ShiftLeft", "KeyA"]);
  a.run(5, ["ShiftLeft"]);
  const dhA = wrap(a.controller.getState().headingDeg - ha0);
  const d = settle();
  const hd0 = d.controller.getState().headingDeg;
  d.run(0.6, ["ShiftLeft", "KeyD"]);
  d.run(5, ["ShiftLeft"]);
  const dhD = wrap(d.controller.getState().headingDeg - hd0);
  check("A banks left / D banks right", dhA < -5 && dhD > 5, `A: heading ${dhA.toFixed(0)}°, D: heading ${dhD.toFixed(0)}°`);
}

console.log(failures === 0 ? "\nALL PHYSICS TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
