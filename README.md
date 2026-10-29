# Flight Simulator — Babylon.js

Browser-based 3D flight simulator built incrementally with **React + Vite + TypeScript + Babylon.js**.

## Phase 4 — Semi-realistic flight physics (current)

The Phase 3 "fly where the nose points" model is replaced by a
force-based simulation in `src/game/AircraftController.ts`, stepped at a
**fixed 120 Hz timestep** through an accumulator in `FlightScene`
(frame time clamped to 100 ms), so physics is identical at any frame
rate.

**Model** (game-oriented, physically meaningful):

- **Thrust** along the nose from throttle, fading with airspeed.
- **Lift** = ½·ρ·v²·S·CL — depends on airspeed *and* angle of attack
  (CL is linear in AoA). Lift acts perpendicular to the airflow, so
  banking tilts the lift vector and *that* is what turns the aircraft
  (plus a coordinated-turn rate Ω = g·tan(bank)/v applied to the nose).
- **Drag** = ½·ρ·v²·S·CD with parasite + induced (CL²) + stall +
  high-speed-rise terms.
- **Gravity**, ground roll with rolling friction, nose-wheel steering
  and a rotation-speed pitch guard.
- **Stall**: beyond +15° / −12° AoA the lift coefficient falls off,
  drag jumps, control power and stability fade, and the nose drops.
- **Gentle stability assistance**: nose eases toward the flight path,
  wings auto-level hands-off, sideslip is damped.

Key numbers: mass 4,600 kg, wing 80 m², max thrust 17.5 kN. Rotation
at ~30 m/s (~110 km/h), stall at ~26 m/s, hands-off climb ≈ 7–10 m/s
at full throttle. Pitch stability is a *speed trim* (fixed trim AoA
plus a bank load-factor term): faster than trim speed and lift curves
the path up, slower and the aircraft settles into a descent — and in a
bank the trim adds the back-pressure that holds altitude in the turn.
Roll has a soft bank limit (~35–50°) and a gentle auto-level.

**State interface (for later HUD work):** `AircraftController.getState()`
returns a `FlightState` — airspeed, altitude, heading, vertical speed,
throttle, angle of attack, pitch, roll, grounded, stall factor, and the
lift/drag/thrust forces. `FlightScene.getFlightState()` and the HUD
telemetry callback use the same object. The bottom bar already shows
speed / altitude / V/S / heading / throttle / AoA plus a STALL warning;
the full HUD comes in a later phase.

**Debugging (development only):** run `npm run dev`, open the browser
console and use `__flightSim.state()` (full FlightState),
`__flightSim.reset()`, `__flightSim.controller`. A headless physics
self-test (Babylon NullEngine, no GPU) lives in `test-headless/`:
`npx tsx test-headless/physics.test.ts` — it verifies parked idle,
ground acceleration, takeoff, climb, a banked turn, stall + recovery,
idle-throttle descent, reset, and frame-rate independence.

### Verify Phase 4 in the browser

1. **Accelerate** — hold **Shift**: throttle % rises, speed builds
   down the runway.
2. **Take off** — at ~125 km/h hold **S**: the nose rises and the
   aircraft lifts off (below that speed, S does almost nothing — no
   airflow, no control power, no lift).
3. **Climb/descend** — keep full throttle and a gentle nose-up attitude
   to climb; cut throttle with **Ctrl** and it settles into a descent.
4. **Turn** — tap **A** or **D** to bank ~25°, release, and watch the
   heading change on the HUD as the tilted lift curves the flight path;
   **Q/E** adds yaw.
5. **Stall** — climb high first (100 m+), cut the throttle and hold
   **S**: speed bleeds, AoA passes 15°, the STALL warning shows, lift
   fades and the aircraft sinks with mushy controls. Recover like a
   real pilot: throttle up, **W** just until the warning clears, then
   a brief **S** pull-out. (Holding W for many seconds dives into the
   ground — that is correct behaviour, not a bug.)
6. **Stability** — the same takeoff flown at a stuttering frame rate
   (or after switching tabs) behaves the same; physics is fixed-step.
7. **Reset** — press **R** any time: back to the runway, stopped.

## Phase 3 — Keyboard input & basic movement

Simple, predictable, frame-rate-independent movement — not an aerodynamic
model. The aircraft moves forward along its nose direction at a speed set
by the throttle; pitch/roll/yaw deflections are smoothed so response is
progressive, and speed chases the throttle setting with a fixed
acceleration limit. Movement lives in `src/game/AircraftController.ts`,
keyboard state in `src/game/InputManager.ts` — both separate from
rendering and UI.

### Controls

| Key | Action |
| --- | --- |
| **W / S** | Pitch — **W nose down, S nose up** (yoke style: push = descend, pull = climb) |
| **A / D** | Roll — bank left / bank right |
| **Q / E** | Yaw — nose left / nose right |
| **Shift** | Increase throttle (hold) |
| **Ctrl** | Decrease throttle (hold) |
| **C** | Cycle camera: Chase → Chase far → Cockpit |
| **R** | Reset aircraft to the runway start (position, level, 0 speed/throttle) |

Notes:

- Input uses `KeyboardEvent.code`, is tracked as a held-key set (continuous
  press works, key repeat is ignored for one-shot keys), and is cleared
  when the window loses focus so keys can never stick.
- While the wheels are on the ground, nose-down pitch and roll are
  blocked (ground guard, so the airframe can't clip the runway); yaw
  still works like nose-wheel steering, and nose-up pitch is allowed.
- There is no lift/gravity yet: at speed, pitch up to climb, pitch down
  to descend; the ground and a 500m ceiling are hard clamps.
- Max speed is 85 m/s (~306 km/h) at 100% throttle.
- The bottom HUD shows live speed (km/h), throttle % and camera mode.
  The Phase 2 "Reset view" button still resets only the camera.
  (Changed in Phase 3: **R** now resets the *aircraft*; in Phase 2 it
  reset the camera.)

### Testing each control in the browser

Click the page once so it has focus, then:

1. **Throttle/speed** — hold **Shift**: throttle % climbs in the HUD,
   speed builds and the plane rolls down the runway. Hold **Ctrl** to
   throttle back down and slow.
2. **Pitch** — at speed, hold **S** to raise the nose and climb; hold
   **W** to push the nose down and descend.
3. **Roll** — once airborne, hold **A** to bank left / **D** to bank
   right; the turn follows the bank.
4. **Yaw** — tap/hold **Q** or **E** to swing the nose left/right
   (works on the ground too, like steering).
5. **Camera** — press **C** repeatedly to cycle Chase → Chase far →
   Cockpit → Chase; the HUD camera label follows.
6. **Reset** — fly somewhere, press **R**: the aircraft instantly
   returns to the runway start, level, stopped, throttle 0.

## Phase 2 — Aircraft & chase camera

- **Improved airplane** (still primitives only, one root transform): rounded nose with cockpit band, passenger window rows, doors and cheatlines, swept wings with dihedral, winglets and red/green navigation lights, two engine nacelles with dark intakes, raked tail fin with rudder + dorsal fin, swept horizontal stabilisers, correctly tapered tail cone, and twin-wheel nose gear + tandem main gears.
- **Starting position:** on the runway centreline near the southern threshold, nose toward -Z with ~178m of runway ahead.
- **Chase camera:** third-person camera held behind (+Z) and above (+Y) the aircraft in aircraft-local space, moved every frame with frame-rate-independent exponential damping (position trails slightly more than the look target, so framing is smooth with no snapping or excess lag). The aircraft stays centred, with the look target slightly ahead of the nose.
- **Camera reset:** the "Reset camera" button in the HUD or the **R** key snaps the camera back to the chase pose.
- Coordinate convention everywhere: forward = -Z, up = +Y, right = +X.

Still no flight physics or flight controls — the aircraft is parked; the chase rig is built on the aircraft's world rotation so it will follow correctly once movement arrives.

## Phase 1 — Foundation

A stable, working 3D foundation. No flight physics or keyboard controls yet.

What's in the scene:

- Full-screen Babylon.js canvas with correct resize handling and clean disposal on unmount
- Clean sky background with light exponential fog
- Large grass ground plane + mowed strip around the runway
- 220m runway with edge lines, centreline dashes and threshold markings
- Taxiway (yellow centreline) and concrete apron
- Airport buildings: 2 hangars, a terminal with glass band, an office block, and a control tower
- Placeholder airplane built **only from Babylon.js primitives** (fuselage, nose, cockpit, wings, tail, engines, landing gear) parked on the runway
- Hemispheric light (sky/ground ambience) + directional "sun" light with blur exponential shadows
- Orbit camera in Phase 1 — replaced by the chase camera in Phase 2

## Tech stack

- React 19, Vite 8, TypeScript
- Babylon.js (`@babylonjs/core` 9.x) used directly — no Three.js / React Three Fiber
- npm

## Project structure

```
src/
  App.tsx                  React shell + HUD overlay
  App.css                  HUD / layout styles
  components/
    SceneCanvas.tsx        React host for the canvas; creates/disposes the scene
  game/
    FlightScene.ts         Engine + Scene, camera, lights, shadows, resize, dispose
    createAirport.ts       Ground, runway, taxiway, apron, buildings, tower, trees
    createAirplane.ts      Placeholder airplane from primitives
    materials.ts           Small StandardMaterial helper
```

## Run locally

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default http://localhost:5173) in your browser.
You should see the airplane centred in a chase view on the runway, with the
airport around it. Hold Shift to throttle up and take off — full control
list and per-control tests are in the Phase 3 section above.

## Checks

```bash
npm run build   # TypeScript check (tsc -b) + production build
npm run lint    # oxlint
```

## Roadmap

- Phase 1: 3D foundation
- Phase 2: detailed airplane + chase camera
- Phase 3: keyboard input + basic movement
- Phase 4: semi-realistic flight physics ← you are here
- Later phases (not started): flight physics, keyboard controls, and more — added one phase at a time.
