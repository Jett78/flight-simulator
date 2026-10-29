/**
 * Phase 9 headless checks for the mission evaluator (pure logic).
 * Synthetic FlightStates drive MissionRun — no Babylon needed.
 *
 * Run: npx tsx test-headless/missions.test.ts
 */
import type { FlightState } from "../src/game/AircraftController";
import { heightAt } from "../src/game/createIsland";
import {
  CHECKPOINTS,
  MissionRun,
  TAKEOFF_TARGET_ALTITUDE,
  checkpointNavigation,
  checkpointVisuals,
} from "../src/game/missions";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function state(over: Partial<FlightState> = {}): FlightState {
  return {
    airspeed: 0,
    altitude: 0,
    headingDeg: 0,
    verticalSpeed: 0,
    throttle: 0,
    angleOfAttackDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    grounded: true,
    stallFactor: 0,
    lift: 0,
    drag: 0,
    thrust: 0,
    phase: "ground",
    onRunway: true,
    surface: "runway",
    heightAboveGround: 0,
    posX: 0,
    posZ: 68,
    crashed: false,
    crashReason: "",
    touchdown: null,
    ...over,
  };
}

/** Airborne state at a checkpoint centre (root world Y = altitude + 2.41). */
function atCheckpoint(i: number): FlightState {
  const cp = CHECKPOINTS[i];
  return state({
    phase: "air",
    grounded: false,
    altitude: cp.y - 2.41,
    posX: cp.x,
    posZ: cp.z,
  });
}

// ---------- M1. Checkpoint ordering ----------
{
  const run = new MissionRun("checkpoints");
  run.step(atCheckpoint(1), 0.1); // fly through ring 2 first — must NOT count
  check("M1a later ring ignored out of order", run.nextIndex === 0 && run.status === "active");
  run.step(atCheckpoint(0), 0.1);
  check("M1b ring 1 counts", run.nextIndex === 1);
  run.step(state({ phase: "air", grounded: false, altitude: 500, posX: 0, posZ: 0 }), 0.1);
  check("M1c far away no progress", run.nextIndex === 1);
  for (let i = 1; i < CHECKPOINTS.length; i++) run.step(atCheckpoint(i), 0.1);
  check("M1d completes after final ring", run.status === "complete", `status=${run.status}`);
  check(
    "M1e score follows the documented formula",
    run.score === Math.max(100, Math.round(1500 - 10 * run.elapsed)),
    `score=${run.score} elapsed=${run.elapsed.toFixed(1)}`,
  );
  const vis = checkpointVisuals(run);
  check("M1f rings cleared on completion", vis.length === 0);
}

// ---------- M2. Checkpoint visuals: next ring is the active one ----------
{
  const run = new MissionRun("checkpoints");
  const vis = checkpointVisuals(run);
  check(
    "M2 visuals mark only the next ring active",
    vis.length === CHECKPOINTS.length && vis[0].active && vis.slice(1).every((v) => !v.active),
  );
  check(
    "M2b visual states: first active, rest upcoming; passed rings completed",
    vis[0].state === "active" &&
      vis.slice(1).every((v) => v.state === "upcoming") &&
      (() => {
        run.step(atCheckpoint(0), 0.1);
        const v2 = checkpointVisuals(run);
        return v2[0].state === "completed" && v2[1].state === "active";
      })(),
  );
}

// ---------- M3. Takeoff & climb ----------
{
  const run = new MissionRun("takeoff");
  run.step(state({ altitude: TAKEOFF_TARGET_ALTITUDE + 50 }), 0.1); // still grounded
  check("M3a altitude on the ground does not count", run.status === "active");
  run.step(state({ phase: "air", grounded: false, altitude: TAKEOFF_TARGET_ALTITUDE - 1 }), 0.1);
  check("M3b just below target not complete", run.status === "active");
  run.step(state({ phase: "air", grounded: false, altitude: TAKEOFF_TARGET_ALTITUDE }), 0.1);
  check("M3c reaching target airborne completes", run.status === "complete", `score=${run.score}`);
}

// ---------- M4. Landing challenge (Phase 7 verdicts only) ----------
{
  const smooth = new MissionRun("landing");
  smooth.step(state({ touchdown: { quality: "smooth", surface: "runway", verticalSpeed: -1, sequence: 7 } }), 0.1);
  check("M4a touchdown before ever airborne ignored", smooth.status === "active");
  smooth.step(state({ phase: "air", grounded: false, altitude: 300, touchdown: null }), 0.1);
  smooth.step(
    state({ touchdown: { quality: "smooth", surface: "runway", verticalSpeed: -1.8, sequence: 8 } }),
    0.1,
  );
  check("M4b smooth runway touchdown completes", smooth.status === "complete" && smooth.landingQuality === "smooth", `score=${smooth.score}`);

  const hard = new MissionRun("landing");
  hard.step(state({ phase: "air", grounded: false, altitude: 200 }), 0.1);
  hard.step(
    state({ touchdown: { quality: "hard", surface: "runway", verticalSpeed: -4.5, sequence: 1 } }),
    0.1,
  );
  check(
    "M4c hard landing completes but scores less than smooth",
    hard.status === "complete" && hard.landingQuality === "hard" && hard.score < smooth.score,
    `hard=${hard.score} smooth=${smooth.score}`,
  );

  const off = new MissionRun("landing");
  off.step(state({ phase: "air", grounded: false, altitude: 200 }), 0.1);
  off.step(
    state({
      surface: "terrain",
      onRunway: false,
      touchdown: { quality: "off-runway", surface: "terrain", verticalSpeed: -1.5, sequence: 1 },
    }),
    0.1,
  );
  check("M4d off-runway touchdown fails the mission", off.status === "failed" && off.score === 0);
}

// ---------- M5. Crash fails any mission ----------
{
  const run = new MissionRun("checkpoints");
  run.step(state({ crashed: true, phase: "crashed", crashReason: "Ditched in the water" }), 0.1);
  check("M5 crash fails with reason", run.status === "failed" && run.failReason.includes("water"));
}

// ---------- M6. Restart = a fresh run ----------
{
  const run = new MissionRun("takeoff");
  run.step(state({ phase: "air", grounded: false, altitude: TAKEOFF_TARGET_ALTITUDE }), 5);
  const fresh = new MissionRun("takeoff"); // what the HUD creates on Restart
  check(
    "M6 restart resets status, timer and score",
    run.status === "complete" && fresh.status === "active" && fresh.elapsed === 0 && fresh.score === 0,
  );
}

// ---------- M7. Timer accumulates only via step dt ----------
{
  const run = new MissionRun("takeoff");
  run.step(state(), 1.5);
  run.step(state(), 2.5);
  check("M7 elapsed sums dt", Math.abs(run.elapsed - 4) < 1e-9, `elapsed=${run.elapsed}`);
  run.step(state({ crashed: true, phase: "crashed", crashReason: "x" }), 10);
  const frozen = run.elapsed;
  run.step(state(), 10);
  check("M7b timer stops when the run ends", run.elapsed === frozen);
}

// ---------- M8. Course safety: every ring clears the terrain ----------
// Regression guard for the 0.9.0 course, whose ring 2 intersected a
// mountain slope. Sample the real island heightfield inside each
// ring's capture radius and demand a flyable margin.
{
  let worst = Infinity;
  let worstIdx = -1;
  CHECKPOINTS.forEach((cp, i) => {
    let maxH = -Infinity;
    for (let dx = -cp.r; dx <= cp.r; dx += 6) {
      for (let dz = -cp.r; dz <= cp.r; dz += 6) {
        if (Math.hypot(dx, dz) <= cp.r) {
          maxH = Math.max(maxH, heightAt(cp.x + dx, cp.z + dz));
        }
      }
    }
    const clearance = cp.y - maxH;
    if (clearance < worst) {
      worst = clearance;
      worstIdx = i;
    }
  });
  check(
    "M8 every ring clears terrain by >20 m inside its radius",
    worst > 20,
    `worst ring ${worstIdx + 1}: ${worst.toFixed(1)} m`,
  );
}

// ---------- M9. Navigation guidance (arrow / turn / climb cues) ----------
{
  const spawn = state(); // (0, 68), altitude 0, heading 000
  const nav = checkpointNavigation(spawn, 0);
  check(
    "M9a from spawn ring 1 is straight ahead",
    nav !== null && nav.direction === "straight" && Math.abs(nav.relativeBearingDeg) < 1,
    `rel=${nav?.relativeBearingDeg.toFixed(1)}`,
  );
  check(
    "M9b distance + climb match the geometry",
    nav !== null &&
      Math.abs(nav.distance - Math.hypot(428, 65 - 2.41)) < 0.5 &&
      Math.abs(nav.altitudeDelta - (65 - 2.41)) < 0.01,
    `dist=${nav?.distance.toFixed(1)} climb=${nav?.altitudeDelta.toFixed(1)}`,
  );
  const facingEast = checkpointNavigation(state({ headingDeg: 90 }), 0);
  check(
    "M9c facing east, ring 1 is a left turn",
    facingEast !== null && facingEast.direction === "left" && facingEast.relativeBearingDeg < -80,
  );
  const toRing2 = checkpointNavigation(atCheckpoint(0), 1);
  check(
    "M9d from ring 1, ring 2 is a right turn",
    toRing2 !== null && toRing2.direction === "right" && toRing2.relativeBearingDeg > 30,
    `rel=${toRing2?.relativeBearingDeg.toFixed(0)}`,
  );
  check("M9e no navigation past the last ring", checkpointNavigation(spawn, 99) === null);
}

console.log(failures === 0 ? "ALL MISSION TESTS PASSED" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
