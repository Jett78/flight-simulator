/**
 * Headless Phase 11 reliability tests:
 * - InputManager: keys never stick after window blur / tab hide,
 *   and dispose() removes every listener.
 * - Saved settings: corrupt localStorage values fall back to safe
 *   defaults (audio prefs, mission records) instead of breaking.
 * - AircraftController: after a crash the aircraft is frozen, and
 *   after reset it is fully controllable again (throttle responds).
 * Runs the REAL modules; DOM/localStorage are minimal stubs.
 * Run with: npx tsx test-headless/reliability.test.ts
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { AircraftController } from "../src/game/AircraftController";
import { InputManager } from "../src/game/InputManager";
import { loadAudioPrefs } from "../src/game/audio";
import { loadRecords, recordCompletion } from "../src/game/missions";
import { createGroundSampler } from "../src/game/runway";

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!ok) failures++;
}

// ---------- DOM + storage stubs ----------
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
const store = new Map<string, string>();
const g = globalThis as unknown as Record<string, unknown>;
g.window = {
  addEventListener: addTo(winHandlers),
  removeEventListener: removeFrom(winHandlers),
};
const fakeDocument: { hidden: boolean; addEventListener: unknown; removeEventListener: unknown } = {
  hidden: false,
  addEventListener: addTo(docHandlers),
  removeEventListener: removeFrom(docHandlers),
};
g.document = fakeDocument;
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const keyEvent = (code: string) => ({
  code,
  repeat: false,
  metaKey: false,
  altKey: false,
  preventDefault: () => undefined,
});

// ---------- InputManager: no stuck keys ----------
{
  const input = new InputManager();
  fire(winHandlers, "keydown", keyEvent("ShiftLeft"));
  fire(winHandlers, "keydown", keyEvent("KeyW"));
  check(
    "held keys register",
    input.isDown("ShiftLeft") && input.isDown("KeyW"),
    "Shift+W down",
  );
  fire(winHandlers, "blur", {});
  check(
    "window blur clears held keys (no stuck throttle/pitch)",
    !input.isDown("ShiftLeft") && !input.isDown("KeyW"),
    "both keys cleared on blur",
  );
  fire(winHandlers, "keydown", keyEvent("KeyA"));
  fakeDocument.hidden = true;
  fire(docHandlers, "visibilitychange", {});
  check(
    "tab hide clears held keys",
    !input.isDown("KeyA"),
    "KeyA cleared on visibilitychange",
  );
  fakeDocument.hidden = false;
  input.dispose();
  const remaining =
    (winHandlers.get("keydown")?.length ?? 0) +
    (winHandlers.get("keyup")?.length ?? 0) +
    (winHandlers.get("blur")?.length ?? 0) +
    (docHandlers.get("visibilitychange")?.length ?? 0);
  check("dispose removes all listeners", remaining === 0, `${remaining} left`);
}

// ---------- Corrupt saved settings ----------
{
  store.set("flightsim.audio.v1", "{not json");
  const prefs = loadAudioPrefs();
  check(
    "corrupt audio prefs fall back to defaults",
    prefs.muted === false && prefs.volume > 0 && prefs.volume <= 1,
    JSON.stringify(prefs),
  );
  store.set("flightsim.audio.v1", JSON.stringify({ muted: "yes", volume: 42 }));
  const clamped = loadAudioPrefs();
  check(
    "out-of-range audio prefs are sanitized",
    clamped.muted === false && clamped.volume === 1,
    JSON.stringify(clamped),
  );
  store.set(
    "flightsim.missions.v1",
    JSON.stringify({
      checkpoints: { best: 900, completions: 2, plays: 3 },
      takeoff: { best: "abc", completions: -5, plays: null },
      landing: "garbage",
    }),
  );
  const records = loadRecords();
  const updated = recordCompletion(records, "takeoff", 500);
  check(
    "corrupt mission records are sanitized and stay usable",
    records.checkpoints?.best === 900 &&
      records.takeoff?.best === 0 &&
      records.takeoff?.completions === 0 &&
      !("landing" in records) &&
      updated.takeoff?.best === 500,
    JSON.stringify(updated),
  );
}

// ---------- Controller: crash freezes, reset restores control ----------
{
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const node = new TransformNode("airplane", scene);
  const START = new Vector3(0, 2.41, 68);
  node.position.copyFrom(START);
  const controller = new AircraftController(node, START, createGroundSampler());
  const fakeInput = {
    keys: new Set<string>(),
    isDown(...codes: string[]) {
      return codes.some((c) => this.keys.has(c));
    },
    wasJustPressed: () => false,
    controlAxes: (out: { pitch: number; roll: number; yaw: number }) => { out.pitch = 0; out.roll = 0; out.yaw = 0; return out; },
    postUpdate: () => undefined,
  };
  const step = (keys: string[], seconds: number) => {
    fakeInput.keys = new Set(keys);
    const n = Math.round(seconds / (1 / 120));
    for (let i = 0; i < n; i++) {
      controller.step(1 / 120, fakeInput as unknown as InputManager);
    }
  };
  // Slam into the ground: place airborne, fast, pointing down at terrain.
  controller.reset();
  node.position.set(400, 30, -200);
  controller.velocity.set(0, -40, -30);
  (controller as unknown as { grounded: boolean }).grounded = false;
  step([], 2);
  const crashed = controller.getState();
  check(
    "hard terrain impact crashes and freezes the aircraft",
    crashed.crashed && crashed.airspeed === 0,
    `crashed=${crashed.crashed} reason="${crashed.crashReason}"`,
  );
  controller.reset();
  step(["ShiftLeft"], 6);
  const after = controller.getState();
  check(
    "after reset the aircraft is controllable again (throttle responds)",
    !after.crashed && after.throttle > 0.5 && after.airspeed > 10,
    `throttle=${after.throttle.toFixed(2)} speed=${after.airspeed.toFixed(1)}`,
  );
  scene.dispose();
  engine.dispose();
}

console.log(failures === 0 ? "\nALL RELIABILITY TESTS PASSED" : `\n${failures} RELIABILITY TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
