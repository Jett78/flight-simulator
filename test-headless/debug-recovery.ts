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

const engine = new NullEngine();
const scene = new Scene(engine);
const node = new TransformNode("airplane", scene);
node.position.copyFrom(START);
const input = new FakeInput();
const c = new AircraftController(node, START);
const asInput = input as unknown as InputManager;

function run(seconds: number, keys: string[], label = "", sampleEvery = 0) {
  input.keys = new Set(keys);
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    c.step(DT, asInput);
    if (sampleEvery > 0 && i % Math.round(sampleEvery / DT) === 0) {
      const s = c.getState();
      console.log(
        `  [${label}] alt=${s.altitude.toFixed(0)} v=${s.airspeed.toFixed(1)} VS=${s.verticalSpeed.toFixed(1)} pitch=${s.pitchDeg.toFixed(0)} AoA=${s.angleOfAttackDeg.toFixed(0)} stall=${s.stallFactor.toFixed(2)} thr=${s.throttle.toFixed(2)} L=${(s.lift / 1000).toFixed(1)}kN D=${(s.drag / 1000).toFixed(1)}kN T=${(s.thrust / 1000).toFixed(1)}kN`,
      );
    }
  }
}
function runUntil(keys: string[], pred: () => boolean, timeout: number) {
  input.keys = new Set(keys);
  let t = 0;
  while (!pred() && t < timeout) {
    c.step(DT, asInput);
    t += DT;
  }
}

run(2.5, ["ShiftLeft"]);
runUntil([], () => c.getState().airspeed >= 38, 30);
runUntil(["KeyS"], () => c.getState().altitude > 80, 30);
run(1.5, []);
console.log("— cutting throttle, holding S —");
run(2.5, ["Space"]);
for (let t = 0; t < 14; t += 0.5) {
  run(0.5, ["KeyS"], "stall", 0.5);
  const s = c.getState();
  if (s.stallFactor > 0.5 && s.verticalSpeed < -3) {
    console.log("  stall developed, breaking to recovery");
    break;
  }
}
console.log("— recovery: W until stall clears, then pull out with S —");
run(2.5, ["ShiftLeft"]); // throttle back to full while still stalled
runUntil(["KeyW"], () => c.getState().stallFactor < 0.05, 2.5);
console.log(`  stall cleared at alt=${c.getState().altitude.toFixed(0)} v=${c.getState().airspeed.toFixed(1)} pitch=${c.getState().pitchDeg.toFixed(0)}`);
run(1.2, ["KeyS"], "pullout", 0.6);
run(6, [], "settle", 1);
const s = c.getState();
console.log(`END alt=${s.altitude.toFixed(0)} v=${s.airspeed.toFixed(1)} stall=${s.stallFactor.toFixed(2)}`);
