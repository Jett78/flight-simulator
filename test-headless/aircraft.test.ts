/**
 * Multi-aircraft Phase 1 headless checks: the aircraft
 * configuration system.
 *
 * R: registry integrity — three aircraft registered, unique ids,
 *    the default is the Cesium Air with EXACTLY the pre-system
 *    physics/camera constants (the game must fly as before),
 *    stored stall speeds agree with each config's own lift
 *    numbers, and registerAircraft() is a working extension
 *    point (new aircraft in, duplicates rejected).
 * F: every registered aircraft actually flies in THIS game's
 *    world — lifts off within the 300 m runway from the spawn,
 *    and sustains a category-appropriate cruise (fighter fastest,
 *    jet next, prop slowest). Plus a drift guard: the default
 *    config through the shared controller reproduces the
 *    pre-system acceleration of the standard variant.
 *
 * Run: npx tsx test-headless/aircraft.test.ts
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { AircraftController } from "../src/game/AircraftController";
import {
  analyticStallSpeed,
  getAircraftConfig,
  listAircraft,
  registerAircraft,
  DEFAULT_AIRCRAFT_ID,
  type AircraftConfig,
} from "../src/game/aircraftConfigs";
import type { InputManager as InputManagerType } from "../src/game/InputManager";

const DT = 1 / 120;
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

class FakeInput {
  keys = new Set<string>();
  isDown(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }
  wasJustPressed(): boolean {
    return false;
  }
  postUpdate(): void {}
  controlAxes(out: { pitch: number; roll: number; yaw: number }) {
    out.pitch = (this.keys.has("KeyS") ? 1 : 0) + (this.keys.has("KeyW") ? -1 : 0);
    out.roll = (this.keys.has("KeyD") ? 1 : 0) + (this.keys.has("KeyA") ? -1 : 0);
    out.yaw = (this.keys.has("KeyE") ? 1 : 0) + (this.keys.has("KeyQ") ? -1 : 0);
    return out;
  }
}

function makeController(config: AircraftConfig, start: Vector3) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const node = new TransformNode("airplane", scene);
  node.position.copyFrom(start);
  const input = new FakeInput();
  const controller = new AircraftController(node, start, undefined, null, undefined, config);
  return { controller, node, input, scene, engine };
}
const step = (
  sim: ReturnType<typeof makeController>,
  steps: number,
) => {
  for (let i = 0; i < steps; i++) sim.controller.step(DT, sim.input as unknown as InputManagerType);
};

// ---------- R. Registry ----------

{
  const fleet = listAircraft();
  const ids = fleet.map((c) => c.id);
  check("R1 three aircraft registered, unique ids", fleet.length === 3 && new Set(ids).size === 3, ids.join(", "));
  const cats = new Set(fleet.map((c) => c.category));
  check(
    "R1b one of each category",
    cats.has("propeller") && cats.has("commercial-jet") && cats.has("fighter"),
    [...cats].join(", "),
  );
  check("R1c unknown id falls back to the default", getAircraftConfig("nope").id === DEFAULT_AIRCRAFT_ID);
}

{
  // The default must carry the pre-config-system constants exactly
  // (AircraftController's old tuning + FlightScene's camera rig).
  const d = getAircraftConfig(DEFAULT_AIRCRAFT_ID);
  const eq = (a: number, b: number) => a === b;
  const pose = (p: { offset: number[]; lookOffset: number[] }, o: number[], l: number[]) =>
    p.offset.every((v, i) => v === o[i]) && p.lookOffset.every((v, i) => v === l[i]);
  check(
    "R2 default config == legacy physics constants",
    eq(d.mass, 4600) && eq(d.thrust, 21000) && eq(d.maxSpeed, 140) && eq(d.wingArea, 92) &&
      eq(d.liftSlope, 5.7) && eq(d.clMax, 1.4) && eq(d.clMin, -1.1) &&
      eq(d.dragParasite, 0.05) && eq(d.dragInduced, 0.05) && eq(d.dragStall, 0.3) &&
      eq(d.pitchRate, 0.8) && eq(d.rollRate, 1.6) && eq(d.yawRate, 0.5) &&
      eq(d.stallAnglePosDeg, 15) && eq(d.stallAngleNegDeg, 12) &&
      eq(d.lapseSpeed, 170) && eq(d.lapseFloor, 0.3) && eq(d.throttleResponse, 1) && eq(d.scale, 1) &&
      eq(d.dragRiseStart, 85) && eq(d.dragRiseSpan, 35) && eq(d.dragRiseAmount, 0.25),
    "mass/thrust/wing/drag/rates/stall/lapse all match the old module constants",
  );
  check(
    "R2b default camera == legacy rig",
    pose(d.camera.chase, [0, 4.4, 14], [0, 1.1, -8]) &&
      pose(d.camera.chaseFar, [0, 7.5, 27], [0, 1.2, -10]) &&
      pose(d.camera.cockpit, [0, 1.7, -4.8], [0, 1.15, -30]),
  );
}

{
  const offs = listAircraft().map(
    (c) => `${c.id}: stored ${c.stallSpeed} vs analytic ${analyticStallSpeed(c).toFixed(1)}`,
  );
  check(
    "R3 stall speeds consistent with each config's lift numbers (±2 m/s)",
    listAircraft().every((c) => Math.abs(analyticStallSpeed(c) - c.stallSpeed) <= 2),
    offs.join(" · "),
  );
}

// ---------- F. Flight per aircraft ----------

{
  // Takeoff: full throttle from the real spawn (z=105, runway
  // ends at z=-150); rotate at 1.15× stall; must be airborne
  // before running out of strip (+20 m of flat apron grace).
  for (const cfg of listAircraft()) {
    const sim = makeController(cfg, new Vector3(0, 2.41, 105));
    sim.input.keys.add("ShiftLeft");
    const rotate = cfg.stallSpeed * 1.15;
    let liftoffZ: number | null = null;
    for (let i = 0; i < 120 * 60 && liftoffZ === null; i++) {
      const st = sim.controller.getState();
      // Rotate like a pilot: pull to ~9° of pitch, then ease off.
      if (st.airspeed > rotate && st.pitchDeg < 9) sim.input.keys.add("KeyS");
      else sim.input.keys.delete("KeyS");
      sim.controller.step(DT, sim.input as unknown as InputManagerType);
      const after = sim.controller.getState();
      if (!after.grounded && after.altitude > 3) liftoffZ = sim.node.position.z;
      if (after.crashed) break;
    }
    check(
      `F1 ${cfg.id} lifts off within the runway`,
      liftoffZ !== null && liftoffZ > -170,
      liftoffZ === null ? "never lifted off" : `airborne at z=${liftoffZ.toFixed(0)} (runway ends −150)`,
    );
    sim.scene.dispose();
    sim.engine.dispose();
  }
}

{
  // Cruise: airborne at 60 m/s, full throttle, hands off the
  // stick for 40 s — each aircraft should settle at a
  // category-appropriate speed, still flying.
  const finals: Record<string, number> = {};
  for (const cfg of listAircraft()) {
    const sim = makeController(cfg, new Vector3(0, 400, 0));
    sim.controller.velocity.set(0, 0, -60);
    sim.input.keys.add("ShiftLeft");
    step(sim, 120 * 40);
    const st = sim.controller.getState();
    finals[cfg.id] = st.grounded || st.crashed ? -1 : st.airspeed;
    sim.scene.dispose();
    sim.engine.dispose();
  }
  check(
    "F2 cruise ordering: fighter > jet > prop, all still flying",
    finals["falcon-f1"] > finals["skyliner-200"] &&
      finals["skyliner-200"] > finals["cesium-air"] &&
      finals["cesium-air"] > 40,
    `fighter ${finals["falcon-f1"].toFixed(0)} · jet ${finals["skyliner-200"].toFixed(0)} · prop ${finals["cesium-air"].toFixed(0)} m/s`,
  );
  check(
    "F2b jet and fighter reach jet speeds (≥115 / ≥150 m/s)",
    finals["skyliner-200"] >= 115 && finals["falcon-f1"] >= 150,
    `jet ${finals["skyliner-200"].toFixed(0)} · fighter ${finals["falcon-f1"].toFixed(0)} m/s`,
  );
}

{
  // Drift guard: default config, standard variant (the
  // controller's own defaults) — the 2 s full-throttle roll must
  // match the pre-system measurement (≈4.6 m/s, Phase 14 V1).
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const node = new TransformNode("airplane", scene);
  const start = new Vector3(0, 2.41, 105);
  node.position.copyFrom(start);
  const input = new FakeInput();
  input.keys.add("ShiftLeft");
  const controller = new AircraftController(node, start);
  for (let i = 0; i < 240; i++) controller.step(DT, input as unknown as InputManagerType);
  const v = controller.getState().airspeed;
  check("F3 legacy drift guard: default still accelerates like before", v > 4.2 && v < 5.0, `${v.toFixed(2)} m/s after 2 s (was ≈4.6)`);
  scene.dispose();
  engine.dispose();
}

// ---------- R4. Extension point (runs last: mutates the registry) ----------

{
  const before = listAircraft().length;
  registerAircraft({ ...getAircraftConfig(DEFAULT_AIRCRAFT_ID), id: "test-glider", name: "Test Glider" });
  let dupThrew = false;
  try {
    registerAircraft({ ...getAircraftConfig(DEFAULT_AIRCRAFT_ID), id: "test-glider", name: "Dupe" });
  } catch {
    dupThrew = true;
  }
  check(
    "R4 registerAircraft adds a new aircraft; duplicate ids are rejected",
    listAircraft().length === before + 1 && getAircraftConfig("test-glider").name === "Test Glider" && dupThrew,
  );
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
