# Flight Simulator — Babylon.js

Browser-based 3D flight simulator built incrementally with **React + Vite + TypeScript + Babylon.js**.

## Phase 1 — Foundation (current)

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
- Orbit camera — drag to orbit, scroll to zoom, right-drag to pan

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
You should see the runway, airport buildings and the airplane on the runway.
Drag to orbit around it.

## Checks

```bash
npm run build   # TypeScript check (tsc -b) + production build
npm run lint    # oxlint
```

## Roadmap

- Phase 1: 3D foundation ← you are here
- Later phases (not started): flight physics, keyboard controls, and more — added one phase at a time.
