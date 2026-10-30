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
import { createGroundSampler } from "../src/game/runway";
import {
  getModelGroundProfile,
  groundOffsetForPitch,
  modelSourceFor,
  normalizeProceduralModel,
  type ModelGroundProfile,
} from "../src/game/aircraftModel";
import { createAirplane } from "../src/game/createAirplane";
import { createFighterJet } from "../src/game/createFighter";
import { TransformNode as TN } from "@babylonjs/core/Meshes/transformNode";

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
      eq(d.dragRiseStart, 85) && eq(d.dragRiseSpan, 35) && eq(d.dragRiseAmount, 0.25) &&
      eq(d.controlResponse, 7),
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


// ---------- H. Phase 3 handling battery ----------

{
  // H1: standing-start acceleration over 5 s (spool + thrust/weight).
  const v: Record<string, number> = {};
  for (const cfg of listAircraft()) {
    const sim = makeController(cfg, new Vector3(0, 2.41, 105));
    sim.input.keys.add("ShiftLeft");
    step(sim, 120 * 5);
    v[cfg.id] = sim.controller.getState().airspeed;
    sim.scene.dispose();
    sim.engine.dispose();
  }
  check(
    "H1 acceleration: fighter > jet > prop",
    v["falcon-f1"] > v["skyliner-200"] && v["skyliner-200"] > v["cesium-air"],
    `fighter ${v["falcon-f1"].toFixed(1)} · jet ${v["skyliner-200"].toFixed(1)} · prop ${v["cesium-air"].toFixed(1)} m/s after 5 s`,
  );
}

{
  // H2a: roll-in — time from level to 45° of bank on full roll
  // input. This is the direct measure of roll response.
  const rollIn: Record<string, number> = {};
  for (const cfg of listAircraft()) {
    const sim = makeController(cfg, new Vector3(0, 400, 0));
    sim.controller.velocity.set(0, 0, -55);
    sim.input.keys.add("KeyA");
    let t = Infinity;
    for (let i = 0; i < 120 * 8; i++) {
      sim.controller.step(DT, sim.input as unknown as InputManagerType);
      if (Math.abs(sim.controller.getState().rollDeg) >= 45) {
        t = (i + 1) * DT;
        break;
      }
    }
    rollIn[cfg.id] = t;
    sim.scene.dispose();
    sim.engine.dispose();
  }
  check(
    "H2a roll-in to 45°: fighter < prop < jet",
    rollIn["falcon-f1"] < rollIn["cesium-air"] && rollIn["cesium-air"] < rollIn["skyliner-200"],
    `fighter ${rollIn["falcon-f1"].toFixed(2)}s · prop ${rollIn["cesium-air"].toFixed(2)}s · jet ${rollIn["skyliner-200"].toFixed(2)}s`,
  );

  // H2b: sustained 180° turn at a latched 55 m/s, bank held at
  // 50° by a wide-deadband pilot. At one shared speed and bank,
  // turn rate is g·tan(bank)/v for everyone — the measured
  // truth is that all three sit near that law, the jet loses
  // seconds to its slow roll-in (widest feel), and the fighter
  // stays close to the light prop despite its small wing. The
  // fighter's agility edge is proven separately by H2a/H1/H3
  // and by the speeds it alone can sustain (F2).
  const times: Record<string, number> = {};
  for (const cfg of listAircraft()) {
    const sim = makeController(cfg, new Vector3(0, 400, 0));
    sim.controller.velocity.set(0, 0, -55);
    let swept = 0;
    let prev = 0;
    let t = 0;
    for (let i = 0; i < 120 * 30; i++) {
      const st = sim.controller.getState();
      const keys = new Set<string>();
      if (st.airspeed < 57) keys.add("ShiftLeft");
      if (!st.grounded) {
        if (st.rollDeg < 43) keys.add("KeyA");
        else if (st.rollDeg > 57) keys.add("KeyD");
        if (st.verticalSpeed < -2.5) keys.add("KeyS");
        else if (st.verticalSpeed > 2.5) keys.add("KeyW");
      }
      sim.input.keys = keys;
      sim.controller.step(DT, sim.input as unknown as InputManagerType);
      const h = sim.controller.getState().headingDeg;
      let d = h - prev;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      swept += d;
      prev = h;
      t += DT;
      if (Math.abs(swept) >= 180) break;
      if (sim.controller.getState().crashed) break;
    }
    times[cfg.id] = Math.abs(swept) >= 180 ? t : Infinity;
    sim.scene.dispose();
    sim.engine.dispose();
  }
  check(
    "H2b sustained turn: jet slowest; fighter within 6 s of the prop",
    times["skyliner-200"] > times["cesium-air"] && times["falcon-f1"] < times["cesium-air"] + 6 && times["falcon-f1"] < times["skyliner-200"] + 2,
    `fighter ${times["falcon-f1"].toFixed(1)}s · prop ${times["cesium-air"].toFixed(1)}s · jet ${times["skyliner-200"].toFixed(1)}s per 180° at 55 m/s`,
  );
}

{
  // H3: climb — mean vertical speed over t=6..9 s at full throttle.
  const vs: Record<string, number> = {};
  for (const cfg of listAircraft()) {
    const sim = makeController(cfg, new Vector3(0, 300, 0));
    sim.controller.velocity.set(0, 0, -50);
    sim.input.keys.add("ShiftLeft");
    step(sim, 120 * 6);
    let sum = 0;
    for (let i = 0; i < 6; i++) {
      step(sim, 60);
      sum += sim.controller.getState().verticalSpeed;
    }
    vs[cfg.id] = sum / 6;
    sim.scene.dispose();
    sim.engine.dispose();
  }
  check(
    "H3 climb: all climb strongly; fighter dominates; jet gradual",
    vs["cesium-air"] > 5 && vs["skyliner-200"] > 8 && vs["falcon-f1"] > 1.5 * vs["cesium-air"],
    `fighter ${vs["falcon-f1"].toFixed(1)} · jet ${vs["skyliner-200"].toFixed(1)} · prop ${vs["cesium-air"].toFixed(1)} m/s`,
  );
}

{
  // H4: stall onset near each config's own angle, then recovery.
  for (const cfg of listAircraft()) {
    const sim = makeController(cfg, new Vector3(0, 400, 0));
    sim.controller.velocity.set(0, 0, -cfg.stallSpeed * 1.7);
    sim.input.keys.add("KeyS"); // idle throttle, pull and hold
    let onsetAlpha: number | null = null;
    for (let i = 0; i < 120 * 25 && onsetAlpha === null; i++) {
      sim.controller.step(DT, sim.input as unknown as InputManagerType);
      const st = sim.controller.getState();
      if (st.stallFactor > 0.5) onsetAlpha = st.angleOfAttackDeg;
      if (st.crashed) break;
    }
    // Recover like a pilot: nose down + full power UNTIL the
    // wing is flying again, then hands off (holding the dive
    // for a fixed 12 s just flies jets into the ground).
    sim.input.keys.delete("KeyS");
    sim.input.keys.add("KeyW");
    sim.input.keys.add("ShiftLeft");
    for (let i = 0; i < 120 * 12; i++) {
      sim.controller.step(DT, sim.input as unknown as InputManagerType);
      const st = sim.controller.getState();
      if (st.stallFactor < 0.1 && st.airspeed > cfg.stallSpeed * 1.3) break;
      if (st.crashed) break;
    }
    sim.input.keys.clear();
    step(sim, 120 * 2);
    const end = sim.controller.getState();
    check(
      `H4 ${cfg.id} stalls at its own angle and recovers`,
      onsetAlpha !== null &&
        Math.abs(onsetAlpha - cfg.stallAnglePosDeg) <= 5 &&
        end.stallFactor < 0.25 &&
        !end.crashed,
      onsetAlpha === null
        ? "never stalled"
        : `onset at ${onsetAlpha.toFixed(1)}° (config ${cfg.stallAnglePosDeg}°), after recovery stall=${end.stallFactor.toFixed(2)}`,
    );
    sim.scene.dispose();
    sim.engine.dispose();
  }
}

{
  // H5: straight-in landing on the real runway sampler at each
  // aircraft's own approach speed — must earn a verdict, not a
  // crash. The test pilot flies a latched throttle (idle on
  // short final, as real approaches are flown) and a VS loop
  // with a wide deadband so it doesn't porpoise a twitchy jet.
  const sampler = createGroundSampler();
  for (const cfg of listAircraft()) {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const node = new TransformNode("airplane", scene);
    const approach = cfg.stallSpeed * 1.26;
    const startZ = approach * 13;
    const groundAtSpawn = sampler(0, startZ).height;
    const start = new Vector3(0, groundAtSpawn + 2.25 + 34, startZ);
    node.position.copyFrom(start);
    const input = new FakeInput();
    const controller = new AircraftController(node, start, sampler, null, undefined, cfg);
    controller.velocity.set(0, 0, -approach);
    let powerOn = true;
    let verdict: string | null = null;
    for (let i = 0; i < 120 * 45; i++) {
      const st = controller.getState();
      if (st.crashed) break;
      if (st.touchdown) {
        verdict = st.touchdown.quality;
        break;
      }
      const g = sampler(node.position.x, node.position.z);
      const agl = node.position.y - (g.height + 2.25);
      const keys = new Set<string>();
      if (agl > 10) {
        if (st.airspeed > approach + 1.5) powerOn = false;
        if (st.airspeed < approach - 1.5) powerOn = true;
        if (powerOn) keys.add("ShiftLeft");
      }
      const targetVS = agl < 2 ? -1.0 : agl < 8 ? -2.0 : -2.4;
      if (!st.grounded) {
        if (st.verticalSpeed < targetVS - 0.6) keys.add("KeyS");
        else if (st.verticalSpeed > targetVS + 0.6) keys.add("KeyW");
      }
      input.keys = keys;
      controller.step(DT, input as unknown as InputManagerType);
    }
    const end = controller.getState();
    check(
      `H5 ${cfg.id} lands on the runway without crashing (approach ${approach.toFixed(0)} m/s)`,
      verdict !== null && verdict !== "off-runway" && !end.crashed,
      verdict === null ? `no touchdown (crashed=${end.crashed})` : `verdict: ${verdict}`,
    );
    scene.dispose();
    engine.dispose();
  }
}


// ---------- M. Phase 4 models ----------

{
  const src = (id: string) => modelSourceFor(getAircraftConfig(id));
  const c = src("cesium-air");
  const j = src("skyliner-200");
  const f = src("falcon-f1");
  check(
    "M1 model sources resolve per config (all three real glTF since Phase 5)",
    c.kind === "gltf" && j.kind === "gltf" && f.kind === "gltf" &&
      getAircraftConfig("skyliner-200").modelPath === "/models/boeing-747.gltf" &&
      getAircraftConfig("skyliner-200").modelYawDeg === 180 &&
      getAircraftConfig("falcon-f1").modelPath === "/models/fighter-jet.gltf" &&
      getAircraftConfig("falcon-f1").modelYawDeg === 180,
    `cesium=${c.kind} · skyliner=${j.kind} · falcon=${f.kind}`,
  );
}

{
  // Phase 5: the shipped model files must exist, parse as glTF
  // JSON, and carry their buffers as embedded data URIs (the
  // repo path is text-only — a binary file here would mean the
  // conversion step was skipped).
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(process.cwd(), "public/models");
  const files = ["cesium-air.gltf", "boeing-747.gltf", "fighter-jet.gltf"];
  const bad: string[] = [];
  for (const f of files) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(root, f), "utf8")) as {
        buffers?: { uri?: string }[];
        meshes?: unknown[];
      };
      const embedded = (doc.buffers ?? []).every((b) => (b.uri ?? "").startsWith("data:"));
      if (!embedded || !(doc.meshes?.length)) bad.push(f);
    } catch {
      bad.push(f);
    }
  }
  check(
    "M4 shipped model files are embedded-text glTF with geometry",
    bad.length === 0,
    bad.length ? `bad: ${bad.join(", ")}` : files.join(" + "),
  );
}

{
  // v0.21.0 ground-rotation clearance: the offset math that
  // keeps the tail/stores out of the runway during rotation.
  const pitch = (12 * Math.PI) / 180;
  const cos = Math.cos(pitch), sin = Math.sin(pitch);
  const mk = (points: Array<{ y: number; z: number }>): ModelGroundProfile => ({
    points,
    pivotZ: 1.0,
    basePosition: new Vector3(0, 0, 0),
  });
  const gearOnly = mk([{ y: -2.25, z: 1.0 }]);
  check(
    "G1 zero pitch means zero offset",
    groundOffsetForPitch(gearOnly, 0).dy === 0 && groundOffsetForPitch(gearOnly, 0).dz === 0,
  );
  const offGear = groundOffsetForPitch(gearOnly, pitch);
  const gearFinalY = -2.25 * cos - 1.0 * sin + offGear.dy;
  check(
    "G2 the gear pivot point stays exactly on the contact plane",
    Math.abs(gearFinalY + 2.25) < 1e-9,
    `pivot lift ${offGear.dy.toFixed(3)} m, final y ${gearFinalY.toFixed(3)}`,
  );
  const tail = { y: -1.1, z: 7.2 };
  const tailPenetrationAboutCentre = -2.25 - (tail.y * cos - tail.z * sin);
  check(
    "G4 gear-pivot lift is smaller than the centre-rotation tail drop",
    offGear.dy < tailPenetrationAboutCentre,
    `pivot lift ${offGear.dy.toFixed(2)} m vs tail drop ${tailPenetrationAboutCentre.toFixed(2)} m`,
  );
  const full = mk([
    { y: -2.25, z: 1.0 },
    tail,
    { y: -2.2, z: 5.0 }, // a low underwing store, nearly at gear depth
    { y: -0.9, z: -6.0 },
  ]);
  const offFull = groundOffsetForPitch(full, pitch);
  const finalY = (p: { y: number; z: number }) => p.y * cos - p.z * sin + offFull.dy;
  check(
    "G3 no sampled point ends below the contact plane at 12° pitch",
    full.points.every((p) => finalY(p) >= -2.25 - 1e-9),
    `tail final y ${finalY(full.points[1]).toFixed(2)} · store ${finalY(full.points[2]).toFixed(2)}`,
  );
}

{
  // Build each procedural model, normalize it exactly as
  // FlightScene does, and measure: fitted length, gear contact,
  // centring, and nose direction (named parts must sit forward).
  const cases = [
    { id: "skyliner-200", build: createAirplane, noseMesh: "nose" },
    { id: "falcon-f1", build: createFighterJet, noseMesh: "fighter-nose" },
  ] as const;
  for (const kase of cases) {
    const cfg = getAircraftConfig(kase.id);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const root = new TN("airplane", scene);
    const container = new TN("aircraft-model", scene);
    container.parent = root;
    const inner = kase.build(scene);
    inner.parent = container;
    normalizeProceduralModel(container, root, 11 * cfg.scale);
    root.computeWorldMatrix(true);
    const { min, max } = root.getHierarchyBoundingVectors(true);
    const length = max.z - min.z;
    const target = 11 * cfg.scale;
    const nose = scene.getMeshByName(kase.noseMesh);
    const noseZ = nose ? nose.getAbsolutePosition().z : 0;
    check(
      `M2 ${kase.id} model fits: length ≈ ${target.toFixed(1)} m, gear at −2.25, nose forward`,
      Math.abs(length - target) / target < 0.06 &&
        Math.abs(min.y + 2.25) < 0.05 &&
        Math.abs((min.x + max.x) / 2) < 0.1 &&
        Math.abs((min.z + max.z) / 2) < 0.1 &&
        noseZ < -target * 0.25,
      `len ${length.toFixed(1)} m · underside ${min.y.toFixed(2)} · nose z ${noseZ.toFixed(1)}`,
    );
    scene.dispose();
    engine.dispose();
  }
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

// ---------------------------------------------------------------------
// Phase 5 — per-aircraft camera behaviour + HUD presentation data.
// The feel lives in the config: follow damping and FOV per
// aircraft, with the default keeping the legacy rig exactly.
// ---------------------------------------------------------------------
{
  const d = getAircraftConfig(DEFAULT_AIRCRAFT_ID);
  const jet = getAircraftConfig("skyliner-200");
  const ftr = getAircraftConfig("falcon-f1");
  check(
    "C1 default camera feel == legacy (damps 3.4/5.5, fov 0.82)",
    d.camera.followPosDamp === 3.4 &&
      d.camera.followTargetDamp === 5.5 &&
      d.camera.fov === 0.82,
  );
  check(
    "C2 follow tightness orders fighter > prop > jet",
    ftr.camera.followPosDamp > d.camera.followPosDamp &&
      d.camera.followPosDamp > jet.camera.followPosDamp &&
      ftr.camera.followTargetDamp > d.camera.followTargetDamp &&
      d.camera.followTargetDamp > jet.camera.followTargetDamp,
    `pos ${jet.camera.followPosDamp}/${d.camera.followPosDamp}/${ftr.camera.followPosDamp}`,
  );
  check(
    "C3 speed-FOV boost orders fighter > jet > prop, all positive",
    ftr.camera.fovBoost > jet.camera.fovBoost &&
      jet.camera.fovBoost > d.camera.fovBoost &&
      d.camera.fovBoost > 0,
    `boost ${d.camera.fovBoost}/${jet.camera.fovBoost}/${ftr.camera.fovBoost}`,
  );
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
