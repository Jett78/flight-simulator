/**
 * Phase 13 headless checks: solid obstacles.
 *
 * A: the real world builders register the volumes we expect.
 * B: controller behaviour against a fake field — slow hit =
 *    blocked (solid), fast hit = crash, flying over = no hit,
 *    trees behave like buildings.
 *
 * Run: npx tsx test-headless/obstacles.test.ts
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { AircraftController } from "../src/game/AircraftController";
import type { InputManager } from "../src/game/InputManager";
import { ObstacleField, type Obstacle } from "../src/game/obstacles";
import { createAirport } from "../src/game/createAirport";
import { createIsland, VILLAGE } from "../src/game/createIsland";

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
}

// ---------- A. The real registry ----------
{
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const island = createIsland(scene);
  const airport = createAirport(scene);
  const field = new ObstacleField([...airport.obstacles, ...island.obstacles]);
  check("A1 registry is populated", field.count > 800, `${field.count} obstacles`);
  check("A2 hangar A is solid", field.query(-70, 3, -22, 4)?.name === "hangar-a");
  check("A3 terminal is solid", field.query(36, 3, -26, 4)?.name === "terminal");
  check("A4 tower is solid", field.query(30, 3, -62, 4)?.name === "tower-shaft");
  check("A5 lighthouse is solid", field.query(1560, 4, -90, 4)?.name === "lighthouse");
  check(
    "A6 village house is solid",
    field.query(VILLAGE.x - 26, VILLAGE.h + 1, VILLAGE.z - 14, 4)?.name === "house-0",
  );
  check("A7 spawn point is clear", field.query(0, 2.41, 105, 4) === null);
  check("A8 runway centre is clear", field.query(0, 2.41, -60, 4) === null);
  scene.dispose();
  engine.dispose();
}

// ---------- B. Controller behaviour ----------
const HANGAR: Obstacle = {
  kind: "box",
  name: "hangar-a",
  minX: -83,
  maxX: -57,
  minZ: -32,
  maxZ: -12,
  baseY: 0,
  topY: 10,
};
const TREE: Obstacle = {
  kind: "cylinder",
  name: "island-tree-0",
  x: 0,
  z: -100,
  radius: 1.5,
  baseY: 0,
  topY: 9,
};

function makeSim(obstacles: Obstacle[], start: Vector3) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const node = new TransformNode("airplane", scene);
  node.position.copyFrom(start);
  const input = new FakeInput();
  const controller = new AircraftController(
    node,
    start,
    undefined,
    new ObstacleField(obstacles),
  );
  return { controller, node, input, scene, engine };
}

/** Step with the velocity pinned, until pred or timeout (seconds). */
function drive(
  sim: ReturnType<typeof makeSim>,
  velocity: Vector3,
  pred: () => boolean,
  timeout: number,
): void {
  let t = 0;
  while (!pred() && t < timeout) {
    sim.controller.velocity.copyFrom(velocity);
    sim.controller.step(DT, sim.input as unknown as InputManager);
    t += DT;
  }
}

{
  // Slow taxi into the hangar's east face: must stop AT the wall.
  const sim = makeSim([HANGAR], new Vector3(-40, 2.41, -22));
  drive(sim, new Vector3(-6, 0, 0), () => sim.controller.getState().crashed, 3);
  const x = sim.node.position.x;
  check(
    "B1 slow hit is blocked, not a crash",
    !sim.controller.getState().crashed && x > -54 && x < -50,
    `stopped at x=${x.toFixed(1)} (wall face -57, aircraft radius 4)`,
  );
  sim.scene.dispose();
  sim.engine.dispose();
}
{
  // Fast into the same wall: crash, with the building named.
  const sim = makeSim([HANGAR], new Vector3(-40, 2.41, -22));
  drive(sim, new Vector3(-25, 0, 0), () => sim.controller.getState().crashed, 3);
  const s = sim.controller.getState();
  check(
    "B2 fast hit crashes into the hangar",
    s.crashed && s.crashReason.includes("hangar"),
    s.crashReason,
  );
  sim.scene.dispose();
  sim.engine.dispose();
}
{
  // Over the top at altitude: no interaction at all.
  const sim = makeSim([HANGAR], new Vector3(-40, 30, -22));
  drive(sim, new Vector3(-25, 0, 0), () => sim.node.position.x < -100, 3);
  check(
    "B3 flying over a building is fine",
    !sim.controller.getState().crashed && sim.node.position.x < -100,
    `crossed at y=${sim.node.position.y.toFixed(1)}`,
  );
  sim.scene.dispose();
  sim.engine.dispose();
}
{
  // Tree at speed: crash. Tree slowly: bumped stop.
  const fast = makeSim([TREE], new Vector3(0, 2.41, -80));
  drive(fast, new Vector3(0, 0, -25), () => fast.controller.getState().crashed, 3);
  const fs = fast.controller.getState();
  check("B4 fast tree hit crashes", fs.crashed && fs.crashReason.includes("tree"), fs.crashReason);
  fast.scene.dispose();
  fast.engine.dispose();

  const slow = makeSim([TREE], new Vector3(0, 2.41, -80));
  drive(slow, new Vector3(0, 0, -4), () => slow.controller.getState().crashed, 6);
  const z = slow.node.position.z;
  check(
    "B5 slow tree hit is blocked",
    !slow.controller.getState().crashed && z > -97.5 && z < -94,
    `stopped at z=${z.toFixed(1)} (tree at -100)`,
  );
  slow.scene.dispose();
  slow.engine.dispose();
}

// ---------- C. Smooth contact (0.13.2) ----------
// The pre-fix model halved velocity on every contact step and
// resolved penetration only after integrating: pressing into a
// building jittered/wandered and grazing a wall felt like lag.
// These pin the new model: slide whole, settle still, corners
// stable, mid-air blocks, fast slide into a second wall crashes.
function pinFor(
  sim: ReturnType<typeof makeSim>,
  velocity: Vector3,
  seconds: number,
  record?: (x: number, z: number) => void,
): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    sim.controller.velocity.copyFrom(velocity);
    sim.controller.step(DT, sim.input as unknown as InputManager);
    record?.(sim.node.position.x, sim.node.position.z);
  }
}
const range = (a: number[]) => Math.max(...a) - Math.min(...a);

{
  // Diagonal into a wall: blocked on x, slides the full length on z.
  const sim = makeSim([HANGAR], new Vector3(-45, 2.41, -16));
  pinFor(sim, new Vector3(-5, 0, -5), 2);
  const p = sim.node.position;
  check(
    "C1 diagonal hit slides along the wall at full tangential speed",
    !sim.controller.getState().crashed && p.x > -53.3 && p.x < -52.6 && p.z <= -24,
    `ended at (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) — face rest x=-52.95, slid from z=-16`,
  );
  sim.scene.dispose();
  sim.engine.dispose();
}
{
  // Head-on press, held: position must be DEAD still (no jitter).
  const sim = makeSim([HANGAR], new Vector3(-45, 2.41, -22));
  pinFor(sim, new Vector3(-5, 0, 0), 2.5);
  const xs: number[] = [];
  const zs: number[] = [];
  pinFor(sim, new Vector3(-5, 0, 0), 1.5, (x, z) => {
    xs.push(x);
    zs.push(z);
  });
  check(
    "C2 held press is stable — no grind jitter",
    !sim.controller.getState().crashed && range(xs) < 0.02 && range(zs) < 0.02,
    `x range ${range(xs).toFixed(3)} m, z range ${range(zs).toFixed(3)} m over 1.5 s pressed`,
  );
  sim.scene.dispose();
  sim.engine.dispose();
}
{
  // Inside corner of two boxes: settle in the pocket, no flip-flop.
  const A: Obstacle = { kind: "box", name: "hangar-a", minX: -83, maxX: -57, minZ: -32, maxZ: 8, baseY: 0, topY: 10 };
  const B: Obstacle = { kind: "box", name: "office-block", minX: -57, maxX: -37, minZ: -32, maxZ: -12, baseY: 0, topY: 10 };
  const sim = makeSim([A, B], new Vector3(-45, 2.41, 2));
  pinFor(sim, new Vector3(-4, 0, -4), 3);
  const xs: number[] = [];
  const zs: number[] = [];
  pinFor(sim, new Vector3(-4, 0, -4), 1, (x, z) => {
    xs.push(x);
    zs.push(z);
  });
  const p = sim.node.position;
  check(
    "C3 corner pocket settles and stays",
    !sim.controller.getState().crashed &&
      Math.abs(p.x - -52.95) < 0.35 &&
      Math.abs(p.z - -7.95) < 0.35 &&
      range(xs) < 0.02 &&
      range(zs) < 0.02,
    `rest (${p.x.toFixed(2)}, ${p.z.toFixed(2)}), ranges ${range(xs).toFixed(3)}/${range(zs).toFixed(3)}`,
  );
  sim.scene.dispose();
  sim.engine.dispose();
}
{
  // Slow flight into a tall building's side, mid-air: blocked.
  const TOWER: Obstacle = { kind: "box", name: "tower-shaft", minX: -83, maxX: -57, minZ: -32, maxZ: -12, baseY: 0, topY: 30 };
  const sim = makeSim([TOWER], new Vector3(-40, 15, -22));
  pinFor(sim, new Vector3(-4, 0, 0), 5);
  const p = sim.node.position;
  check(
    "C4 slow mid-air hit is blocked, not a crash",
    !sim.controller.getState().crashed && p.x > -53.3 && p.x < -52.6,
    `stopped at x=${p.x.toFixed(2)}, y=${p.y.toFixed(1)}`,
  );
  sim.scene.dispose();
  sim.engine.dispose();
}
{
  // Sliding FAST along one wall into a perpendicular wall: crash.
  const A: Obstacle = { kind: "box", name: "hangar-a", minX: -83, maxX: -57, minZ: -32, maxZ: 8, baseY: 0, topY: 10 };
  const B: Obstacle = { kind: "box", name: "office-block", minX: -57, maxX: -37, minZ: -32, maxZ: -12, baseY: 0, topY: 10 };
  const sim = makeSim([A, B], new Vector3(-52.95, 2.41, 2));
  drive(sim, new Vector3(0, 0, -14), () => sim.controller.getState().crashed, 3);
  const s = sim.controller.getState();
  check(
    "C5 fast slide into the cross wall crashes (and names it)",
    s.crashed && s.crashReason.includes("office"),
    s.crashReason,
  );
  sim.scene.dispose();
  sim.engine.dispose();
}

console.log(failures === 0 ? "\nALL OBSTACLE TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
