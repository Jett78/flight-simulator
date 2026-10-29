# Flight Simulator — Babylon.js

Browser-based 3D flight simulator built incrementally with **React + Vite + TypeScript + Babylon.js**.

## Phase 2 — Aircraft & chase camera (current)

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
airport around it. Press R (or the Reset camera button) to re-centre the view.

## Checks

```bash
npm run build   # TypeScript check (tsc -b) + production build
npm run lint    # oxlint
```

## Roadmap

- Phase 1: 3D foundation
- Phase 2: detailed airplane + chase camera ← you are here
- Later phases (not started): flight physics, keyboard controls, and more — added one phase at a time.
