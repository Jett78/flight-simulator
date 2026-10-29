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

function run(seconds: number, keys: string[], label: string, sampleEvery = 2) {
  input.keys = new Set(keys);
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    c.step(DT, asInput);
    if (i % Math.round(sampleEvery / DT) === 0) {
      const s = c.getState();
      console.log(
        `  [${label}] alt=${s.altitude.toFixed(0)} v=${s.airspeed.toFixed(1)} VS=${s.verticalSpeed.toFixed(1)} pitch=${s.pitchDeg.toFixed(0)} AoA=${s.angleOfAttackDeg.toFixed(1)} roll=${s.rollDeg.toFixed(0)} stall=${s.stallFactor.toFixed(2)} thr=${s.throttle.toFixed(2)} gnd=${s.grounded}`,
      );
    }
  }
}
function runUntil(keys: string[], pred: () => boolean, timeout: number, label: string) {
  input.keys = new Set(keys);
  let t = 0;
  while (!pred() && t < timeout) {
    c.step(DT, asInput);
    t += DT;
  }
  const s = c.getState();
  console.log(`  [${label} done t=${t.toFixed(1)}s] alt=${s.altitude.toFixed(0)} v=${s.airspeed.toFixed(1)} VS=${s.verticalSpeed.toFixed(1)} pitch=${s.pitchDeg.toFixed(0)} AoA=${s.angleOfAttackDeg.toFixed(1)}`);
}

run(2.5, ["KeyW"], "throttle", 99);
runUntil([], () => c.getState().airspeed >= 38, 30, "roll");
runUntil(["ArrowUp"], () => c.getState().altitude > 110, 60, "climb");
runUntil(["ArrowDown"], () => c.getState().verticalSpeed <= 0.5, 8, "level-out");
console.log("— 22s hands-off cruise —");
run(22, [], "cruise", 2);
