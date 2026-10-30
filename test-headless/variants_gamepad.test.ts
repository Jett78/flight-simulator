/**
 * Phase 14 headless checks: aircraft variants + gamepad input.
 *
 * V: variant profiles change the flight model in the promised
 *    directions (Sport accelerates hardest and rolls fastest,
 *    Trainer is gentlest and stalls latest; Standard = baseline).
 * G: InputManager gamepad mapping — sticks with deadzone feed
 *    controlAxes with the 0.12.1 sign conventions, RT/LT act as
 *    Shift/Space, A/Y produce camera/reset edges, Start produces
 *    the KeyP pause dispatch. Uses the real InputManager with a
 *    synthetic pad provider and the reliability suite's DOM stub.
 *
 * Run: npx tsx test-headless/variants_gamepad.test.ts
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { AircraftController } from "../src/game/AircraftController";
import { InputManager } from "../src/game/InputManager";
import { aircraftVariantById } from "../src/game/aircraftVariants";
import type { InputManager as InputManagerType } from "../src/game/InputManager";

const DT = 1 / 120;
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---------- DOM stubs (pattern from reliability.test.ts) ----------
type Handler = (event: never) => void;
const winHandlers = new Map<string, Handler[]>();
const docHandlers = new Map<string, Handler[]>();
const addTo = (map: Map<string, Handler[]>) => (type: string, fn: Handler) => {
  map.set(type, [...(map.get(type) ?? []), fn]);
};
const removeFrom = (map: Map<string, Handler[]>) => (type: string, fn: Handler) => {
  map.set(type, (map.get(type) ?? []).filter((f) => f !== fn));
};
const fire = (map: Map<string, Handler[]>, type: string, event: unknown) => {
  for (const fn of map.get(type) ?? []) (fn as (e: unknown) => void)(event);
};
const dispatched: { type: string; code?: string }[] = [];
const g = globalThis as unknown as Record<string, unknown>;
g.window = {
  addEventListener: addTo(winHandlers),
  removeEventListener: removeFrom(winHandlers),
  dispatchEvent: (e: { type: string; code?: string }) => {
    dispatched.push({ type: e.type, code: e.code });
    return true;
  },
};
g.document = {
  hidden: false,
  addEventListener: addTo(docHandlers),
  removeEventListener: removeFrom(docHandlers),
};
g.KeyboardEvent = class {
  type = "keydown";
  code: string;
  constructor(_type: string, init?: { code?: string }) {
    this.code = init?.code ?? "";
  }
};
const keyEvent = (code: string) => ({
  code,
  repeat: false,
  metaKey: false,
  altKey: false,
  preventDefault: () => undefined,
});

// ---------- V. Variants ----------
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

function makeController(variantId: string, start: Vector3) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const node = new TransformNode("airplane", scene);
  node.position.copyFrom(start);
  const input = new FakeInput();
  const controller = new AircraftController(
    node,
    start,
    undefined,
    null,
    aircraftVariantById(variantId),
  );
  return { controller, node, input, scene, engine };
}

{
  // Full-throttle ground roll for 2 s: acceleration ordering.
  const speeds: Record<string, number> = {};
  for (const id of ["trainer", "standard", "sport"]) {
    const sim = makeController(id, new Vector3(0, 2.41, 105));
    sim.input.keys.add("ShiftLeft");
    for (let i = 0; i < 240; i++) sim.controller.step(DT, sim.input as unknown as InputManagerType);
    speeds[id] = sim.controller.getState().airspeed;
    sim.scene.dispose();
    sim.engine.dispose();
  }
  check(
    "V1 acceleration: Sport > Standard > Trainer",
    speeds.sport > speeds.standard && speeds.standard > speeds.trainer,
    `sport ${speeds.sport.toFixed(1)} · standard ${speeds.standard.toFixed(1)} · trainer ${speeds.trainer.toFixed(1)} m/s after 2 s`,
  );
}
{
  // Airborne roll authority: hold A (bank right) for 1 s at speed.
  const rolls: Record<string, number> = {};
  for (const id of ["trainer", "standard", "sport"]) {
    const sim = makeController(id, new Vector3(0, 200, 0));
    sim.controller.velocity.set(0, 0, -40);
    sim.input.keys.add("KeyA");
    for (let i = 0; i < 42; i++) sim.controller.step(DT, sim.input as unknown as InputManagerType);
    rolls[id] = Math.abs(sim.controller.getState().rollDeg);
    sim.scene.dispose();
    sim.engine.dispose();
  }
  check(
    "V2 roll rate: Sport > Standard > Trainer",
    rolls.sport > rolls.standard && rolls.standard > rolls.trainer,
    `sport ${rolls.sport.toFixed(0)}° · standard ${rolls.standard.toFixed(0)}° · trainer ${rolls.trainer.toFixed(0)}° bank after 0.35 s`,
  );
}
{
  // Stall onset at AoA ≈ 17°: Trainer (shift +3°) not yet stalled,
  // Standard (15°) partially, Sport (13°) deepest.
  const stalls: Record<string, number> = {};
  for (const id of ["trainer", "standard", "sport"]) {
    const sim = makeController(id, new Vector3(0, 200, 0));
    const a = (17 * Math.PI) / 180;
    sim.controller.velocity.set(0, -Math.sin(a) * 40, -Math.cos(a) * 40);
    sim.controller.step(DT, sim.input as unknown as InputManagerType);
    stalls[id] = sim.controller.getState().stallFactor;
    sim.scene.dispose();
    sim.engine.dispose();
  }
  check(
    "V3 stall shift: Sport stalls first, Trainer last",
    stalls.sport > stalls.standard && stalls.standard > 0 && stalls.trainer === 0,
    `sport ${stalls.sport.toFixed(2)} · standard ${stalls.standard.toFixed(2)} · trainer ${stalls.trainer.toFixed(2)} at AoA 17°`,
  );
}

// ---------- G. Gamepad ----------
interface FakePad {
  axes: number[];
  buttons: { pressed: boolean; value: number }[];
}
const makePad = (): FakePad => ({
  axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
});

{
  const input = new InputManager();
  const pad = makePad();
  input.setGamepadProvider(() => pad as unknown as Gamepad);
  const axes = { pitch: 0, roll: 0, yaw: 0 };

  pad.axes[0] = 1; // left stick full right
  input.controlAxes(axes);
  check("G1 stick right banks right (roll target -1)", axes.roll === -1, `roll=${axes.roll}`);
  pad.axes[0] = 0.1; // inside deadzone
  input.controlAxes(axes);
  check("G2 deadzone swallows small deflections", axes.roll === 0, `roll=${axes.roll}`);
  pad.axes[0] = 0;
  pad.axes[1] = 1; // pull back
  input.controlAxes(axes);
  check("G3 stick pull = nose up (pitch target +1)", axes.pitch === 1, `pitch=${axes.pitch}`);
  pad.axes[1] = 0;
  pad.axes[2] = -1; // right stick left
  input.controlAxes(axes);
  check("G4 right-stick left yaws left (yaw target +1)", axes.yaw === 1, `yaw=${axes.yaw}`);
  pad.axes[2] = 0;

  pad.buttons[7].pressed = true; // RT
  check("G5 RT acts as Shift (throttle)", input.isDown("ShiftLeft"), "RT held");
  pad.buttons[7].pressed = false;
  pad.buttons[1].pressed = true; // B
  check("G6 B acts as Space (throttle cut)", input.isDown("Space"), "B held");
  pad.buttons[1].pressed = false;

  pad.buttons[0].pressed = true; // A
  input.postUpdate();
  check("G7 A button edge = camera (KeyC)", input.wasJustPressed("KeyC"), "A pressed");
  input.postUpdate(); // held: no repeat edge; this call also clears
  check("G8 held A does not repeat the edge", !input.wasJustPressed("KeyC"), "A still held");
  pad.buttons[0].pressed = false;
  input.postUpdate();

  pad.buttons[3].pressed = true; // Y
  input.postUpdate();
  check("G9 Y button edge = reset (KeyR)", input.wasJustPressed("KeyR"), "Y pressed");
  pad.buttons[3].pressed = false;
  input.postUpdate();

  dispatched.length = 0;
  pad.buttons[9].pressed = true; // Start
  input.postUpdate();
  check(
    "G10 Start dispatches the KeyP pause press",
    dispatched.some((d) => d.type === "keydown" && d.code === "KeyP"),
    JSON.stringify(dispatched),
  );
  pad.buttons[9].pressed = false;
  input.postUpdate();

  input.setGamepadProvider(null);
  fire(winHandlers, "keydown", keyEvent("KeyS"));
  input.controlAxes(axes);
  check("G11 keyboard still drives the axes (S = pitch +1)", axes.pitch === 1, `pitch=${axes.pitch}`);
  fire(winHandlers, "keyup", keyEvent("KeyS"));
  input.dispose();
}

console.log(failures === 0 ? "\nALL VARIANT + GAMEPAD TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
