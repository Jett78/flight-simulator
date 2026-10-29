# Flight Simulator — Babylon.js

Browser-based 3D flight simulator built incrementally with **React + Vite + TypeScript + Babylon.js**.

## Phase 10 — Sound & weather (current)

Lightweight audio and atmosphere, layered on without touching
the flight model, controls or missions.

- **Procedural sound** (`src/game/audio.ts`, Web Audio — no audio
  files, no paid APIs): engine hum that follows throttle and
  airspeed, wind rush that builds with speed while airborne, a
  liftoff whoosh, touchdown thumps (a hard landing sounds lower
  and louder), a crash burst, a checkpoint blip and a
  mission-complete arpeggio.
- **Autoplay rules respected:** the audio context is created only
  on the first click or keypress. **🔊 Sound / 🔇 Muted** toggle and
  a volume slider sit in the top-right actions; both persist in
  localStorage.
- **Fog & sky:** the scene's exponential fog and sky colour are
  tuned per weather. (A billboard cloud layer shipped in 0.10.0
  and was removed in 0.10.1 at Jeet's request.)
- **Weather button** (top right) cycles **☀ Clear → ☁ Cloudy →
  ⛈ Storm**: progressively thicker fog and a greyer sky. The
  choice persists locally.
- **Wind is environmental only** — it flavours the wind sound.
  It is deliberately NOT in the flight model, so airspeed keeps
  its existing meaning and weather can never change how the
  aircraft flies.

**Verify:** click anywhere once (audio unlocks — a quiet engine
idle starts), hold Shift and the engine note rises with throttle;
the 🔊 button mutes everything and the slider sets the level.
Cycle the weather button: Storm visibly greys the sky and
thickens the fog. Headless: `test-headless/audio.test.ts` (level
mappings, mute/volume behaviour against a fake AudioContext) and
`worldbuild.ts` (weather presets apply their fog exactly).

## Phase 9 — Missions

A simple mission system layered on the existing simulation —
physics, controls, HUD and the Phase 7 landing detection are
unchanged, and the landing mission is judged by that same
touchdown system (there is no second one).

- **🏁 Missions menu** (top right): Free Flight stays the default;
  starting a mission resets the aircraft to the start line. Best
  scores are kept locally (browser localStorage only — no backend).
- **Checkpoint Flight:** five glowing rings around the island —
  the next one is gold, passed ones turn green, later ones blue.
  Fly through them in order; passing a later ring early does not count.
- **Takeoff & Climb:** take off and reach 120 m, judged from the
  real altitude and airborne state.
- **Landing Challenge:** take off, return, and touch down on the
  runway — the Phase 7 verdict decides: smooth/hard completes it,
  off-runway or a crash fails it.
- **In-flight display:** a compact objective line under the status
  readout (next ring + distance, altitude progress, or landing
  objective, plus the mission timer), a result card with score /
  time / landing quality, and Restart on both the objective line
  and the result card. The timer pauses with the sim.

**Scoring rules** (identical in `src/game/missions.ts`):

| Mission | Score |
| --- | --- |
| Checkpoint Flight | max(100, 1500 − 10 × seconds) |
| Takeoff & Climb | max(100, 1000 − 10 × seconds) |
| Landing Challenge | smooth 1000 / hard 600, − 5 × seconds, min 100 |
| Any failure (crash, off-runway) | 0 — never a completion |

**Navigation & playability update (0.9.1)** — after live play the
checkpoint course was hard to follow (a ring 600 m away is a few
pixels, and nothing said where the next one was) and ring 2 turned
out to intersect a mountain slope. Now:

- **Follow the gold:** the next ring gets a tall pulsing light
  pillar visible across the island, a thick gold route ribbon runs
  spawn → ring 1 → … → ring 5 (passed legs turn green), every ring
  carries a numbered badge facing the camera, and marker materials
  ignore fog so they stay readable at distance.
- **HUD guidance:** the objective line gained a steering arrow plus
  plain-English cues — “Ring 2/5 · 384 m · Turn right 35° · Climb
  48 m” — a **mission minimap** (top-left: island, runway, route,
  ring states, your live position/heading), and a “✓ Ring done”
  toast when you pass one.
- **Easier, safer course:** rings are bigger (42 m capture radius),
  the legs are shorter, the first climb is gentler, and every ring
  now clears the terrain by 40+ m inside its radius — locked in by
  a headless test that samples the real island heightfield.
- The parked-aircraft STALL banner no longer shows on the ground.

**Verify:** open 🏁 Missions, start Checkpoint Flight — the gold
beacon and route ribbon are visible from the start line, the map
appears top-left, and the objective line points you at ring 1
(“Fly straight · Climb 63 m” from spawn). Takeoff & Climb completes
at 120 m; the Landing Challenge completes only on a real runway
touchdown. Headless: `test-headless/missions.test.ts` covers
ordering, completion, scoring, failure, restart, navigation math
and terrain clearance. Also live at
https://flightsimulator.jeetdeula.com.np/

## Phase 8 — Models & materials

The placeholder look is upgraded without touching the flight model:

- **Aircraft model:** a real glTF model — *Cesium Air*, a low-poly
  twin-prop (CC BY 4.0, © Cesium; full credit in `ASSETS.md`) —
  stored locally in `public/models/` (no CDN, no paid service).
  `src/game/aircraftModel.ts` loads it asynchronously and swaps it
  in for the primitive placeholder; **if the load fails for any
  reason, the placeholder simply stays** — the sim never depends on
  the asset. Fitting is measured at load: the nose direction is
  derived from the propeller positions, and a model-root transform
  yaws it to the sim's −Z forward, scales it to ~11 m, and sets its
  underside exactly on the physics gear contact (−2.25 m). Physics
  and collision dimensions are unchanged and never read the model.
  The file's propeller animations play. Controls, chase camera,
  landing detection and reset all act on the same aircraft root as
  before, so they are unaffected.
- **Trees:** still fully instanced (4 draw calls for ~650 trees),
  now with two foliage tones and a second cone tier stepped wide
  and high enough to read as a two-tier pine silhouette.
- **Post-release fix (0.8.1+, Jeet's live feedback):** the
  aircraft no longer flashes the placeholder for a second before
  the model swaps in — it stays hidden until exactly one aircraft
  (model, or placeholder on load failure) is ready. The control
  scheme stays the classic one — W/S pitch, A/D bank, Shift
  throttle — with one change: **Space replaces Ctrl** as the fast
  throttle cut.
- **Cockpit camera:** re-seats itself to the model's cabin when
  the model loads (the fitted fuselage sits low, so the eye sits
  just above its roof with the nose band in the lower frame); the
  placeholder keeps its original cockpit preset if the model is
  unavailable.
- **Buildings:** terminal, office and tower shaft wear a window
  facade — a 512×256 texture drawn once on a canvas at build time
  (pale concrete, window grid, ground floor). Where no canvas
  exists (headless tests), a plain material is used instead.
- **Terrain:** vertex-colour tint is now smooth low-frequency
  patchiness instead of per-vertex grain — reads as meadow/forest
  variation from altitude.
- Lighting and the single shadow-casting sun are unchanged, so
  performance characteristics are the same as Phase 7.

## Phase 7 — Runway interaction, landing & crashes

The world is now solid, and arrivals are judged:

- **One source of truth for the runway** (`src/game/runway.ts`):
  18 m × 220 m, top at y = 0.16, long axis on Z — matching the
  visual mesh. A ground sampler built on it (plus the island's
  analytic `heightAt` and sea level) is injected into the flight
  controller: every step the aircraft knows the surface under it —
  runway, terrain, or water — its height, and its slope.
- **Ground interaction:** the wheels rest on the real surface
  anywhere (runway 2.41 m root height, grass 2.25 m, hillsides at
  terrain height + gear). Rolling friction is surface-dependent
  (asphalt 0.35, rough ground 0.85, stronger when braking at idle),
  and slope resistance bleeds speed on uphill ground rolls. The
  ground still cannot be rotated through, and nothing pins the
  aircraft down — liftoff happens the moment lift wins.
- **Touchdown evaluation** at the moment of contact (after a real
  airborne period, not ground-roll bumps): sink rate, bank, pitch,
  surface and slope decide the verdict — **smooth** (≤ 2.5 m/s on
  the runway), **hard** (up to 5.5 m/s), **off-runway** (gentle, on
  terrain), or a **crash**: sink beyond 5.5 m/s, bank beyond 28°,
  nose-first below −12°, a hillside steeper than 15°, rough ground
  faster than 45 m/s, or any contact with the sea (ditched).
- **Crash state:** motion stops, controls go dead, and the HUD
  shows a crash overlay with the reason and a reset action
  (button or **R**), restoring the exact start state.
- **HUD feedback:** a status line shows *Ready for takeoff*,
  *Takeoff roll*, *Airborne*, *Approaching runway*, and the
  touchdown verdict with its sink rate — quiet the rest of the time.
- **Also in this release** (Jeet's live fixes): the throttle is
  spring-loaded — hold **Shift** for power, release and it falls
  back to zero, **Space** is a fast cut; and the takeoff is brisker
  (21 kN thrust, 92 m² wing) — liftoff after ~116 m of the 178 m
  available, at ~101 km/h.
- Verified headlessly (`test-headless/ground.test.ts`, 13 checks):
  spawn state, takeoff, a stabilized runway landing, a full
  circuit, an off-runway grass landing, a hard landing, hillside
  and sea crashes, crash freeze, and reset. The Phase 4 physics
  suite still passes in full.

## Phase 6 — Flight HUD

A React HUD (kept fully separate from the Babylon layer) driven by
the live simulation state:

- **Update path:** one `requestAnimationFrame` loop in
  `src/components/Hud.tsx` reads `FlightScene.getFlightState()` each
  frame and writes values straight to DOM nodes via refs — no
  per-frame React re-renders. React state covers only discrete UI:
  camera mode, pause, and the help panel.
- **Instruments:** airspeed tape (km/h) at the left edge, altitude
  tape (m) + vertical-speed indicator (±20 m/s) at the right edge,
  heading compass strip (bottom centre, wraps through 360°),
  throttle bar with AoA (bottom-left), and an artificial horizon
  with pitch/roll readouts (bottom-right). The centre of the screen
  stays clear of the aircraft and runway.
- **Extras:** stall banner, ON GROUND / AIRBORNE chip, camera-mode
  indicator, Pause button (also the **P** key — physics freezes,
  rendering continues), Reset aircraft / Reset view buttons, and a
  collapsible Controls help panel.
- Style: translucent dark panels, thin borders, tabular numerals;
  the layout compresses at tablet/phone widths.

## Phase 5 — Island environment

A procedural island replaces the flat Phase 1 ground (`src/game/createIsland.ts`).
One analytic height function drives the terrain mesh, its vertex
colours and all object placement, so everything sits on the ground by
construction:

- **Terrain** — a single static heightfield (150×150 subdivisions,
  ~45k triangles): perfectly flat pad under the existing airport
  (runway/start/physics untouched), rolling hills growing with
  distance, five mountains (105–165 m) placed away from the departure
  corridor, and a coastline at ~1,080 m radius falling to a seabed.
- **Vertex-colour styling** — sand beaches at sea level, grass,
  forest green, rock on steep faces and high ground, snow caps above
  ~132 m.
- **Ocean** — a single large plane at −1.8 m with a sun specular.
- **Sky** — a gradient dome (pale horizon to deep blue zenith),
  thinner distance fog retuned for the 2.8 km island scale.
- **Vegetation & landmarks** — ~650 instanced trees (2 draw calls),
  a 6-house village on a flattened shore pad (SE), and a lighthouse
  on the east headland. Airport buildings/runway are the Phase 1 set,
  unchanged.

Physics note: the flight model's ground level is still the runway
datum (Phase 4) — terrain collision is not part of this phase, so
treat the hills as scenery you fly *over*; departure toward −Z is
kept clear by design.

### Verify Phase 5 in the browser

On load you should see the runway ahead, green hills and blue ocean
around the airfield, and mountains in the distance. Take off (Shift,
then S at ~110 km/h), climb and turn: beaches ring the island, the
village sits on the south-east shore, the lighthouse stands on the
east coast, and snow-capped peaks ring the island. Fly a full circuit
— the island is ~2.2 km across, so you stay "in the world" the whole
time.

## Phase 4 — Semi-realistic flight physics

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
   to climb; cut throttle with **Space** and it settles into a descent.
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
| **Shift** | Throttle up (hold — release and power falls back to zero) |
| **Space** | Fast throttle cut (hold) |
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
   speed builds and the plane rolls down the runway. Hold **Space** to
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
- Phase 4: semi-realistic flight physics
- Phase 5: procedural island environment
- Phase 6: flight HUD
- Phase 7: runway interaction, landing & crash detection
- Phase 8: glTF aircraft model + material upgrades ← you are here
- Later phases (not started): added one phase at a time, on request.
