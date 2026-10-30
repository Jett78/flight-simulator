# Asset credits & licenses

Everything else in the scene (island, runway, buildings, trees,
village, lighthouse) is generated procedurally in code — no
external assets, no paid services, no runtime API calls.

## Aircraft model — `public/models/cesium-air.gltf` (Cesium Air)

- **What:** "Cesium Air", a low-poly twin-propeller aircraft
  (~0.8 MB, textures embedded).
- **Source:** CesiumGS/cesium GitHub repository,
  `Apps/SampleData/models/CesiumAir/Cesium_Air.glb`
  (https://github.com/CesiumGS/cesium).
- **Copyright / license:** © Cesium. Licensed under the
  **Creative Commons Attribution 4.0 International (CC BY 4.0)**
  license — free to use with attribution (this file). The model also
  appears in the Khronos glTF sample models collection under the
  same terms.
- **Format note:** the original download is a binary GLB. The copy
  in this repo is the same model converted losslessly to glTF JSON
  with embedded data-URI buffers/textures (identical geometry,
  materials, textures and animations), purely so the asset can be
  stored as text in git.
- **Changes made:** none to the model itself. At load time the app
  measures the model and fits it to the simulation (uniform scale
  to ~11 m, nose aligned to the sim's −Z forward, underside on the
  gear contact) via a model-root transform — see
  `src/game/aircraftModel.ts`. The propeller animation groups from
  the file are played.
- **Fallback:** if the file cannot be loaded for any reason, the
  built-in primitive placeholder aircraft is used instead; the
  simulation never depends on this asset.

## Aircraft model — `public/models/boeing-747.gltf` (Boeing 747)

- **What:** "Airplane" — a twin-engine commercial airliner with
  a full passenger-window row, cockpit glass and a blue/white
  livery, flown by the commercial-jet aircraft (config id
  `skyliner-200`). ~259 KB, vertex-coloured materials, no
  textures.
- **Source:** Poly Pizza, model page
  https://poly.pizza/m/a3XrQkLNna9 (file served from
  static.poly.pizza).
- **Copyright / license:** © **Poly by Google**. Licensed under
  **Creative Commons Attribution (CC-BY)**, as shown on the
  model page — free to use with attribution (this file).
- **Format note:** same GLB → embedded-text glTF conversion as
  the Cesium Air above; the original binary is kept outside the
  repo. The file's nose faces +Z in Babylon space, so the
  config sets `modelYawDeg: 180` and the fit turns it to the
  sim's −Z forward (verified by an in-game yaw sweep: 180° =
  symmetric rear view, tail nearest the chase camera; the
  fuselage top line measures level, so no pitch correction).
- **History:** this model replaced a "Boeing 747" by Miha Lunar
  (CC-BY 3.0, poly.pizza/m/49CLof4tP2V) in v0.20.0 — that file
  is authored in a ~26° nose-down pose and has no windows.
- **Changes made:** none to the model itself; the loader's
  measured fit scales it to the config's 28.6 m length and puts
  its underside on the gear contact.

## Aircraft model — `public/models/fighter-jet.gltf` (Falcon F1)

- **What:** "Jet" — a faceted stealth fighter (canopy, canted
  twin tails, underwing stores), flown by the fighter aircraft
  (config id `falcon-f1`). ~100 KB, no textures.
- **Source:** Poly Pizza, model page
  https://poly.pizza/m/6fyLMORhgGK (file served from
  static.poly.pizza).
- **Copyright / license:** © **jeremy**. Licensed under
  **CC-BY 3.0** — free to use with attribution (this file).
- **Format note:** same GLB → embedded-text glTF conversion as
  above. The file's nose faces +Z, so the config sets
  `modelYawDeg: 180` and the fit turns it to the sim's −Z
  forward.
- **Changes made:** none to the model itself; the loader's
  measured fit scales it to the config's 14.85 m length and puts
  its underside on the gear contact.

## Procedural fallback aircraft (Phase 4)

Two aircraft shapes are also **procedurally built in code** (no
external files, no licenses involved). They are no longer the
primary visuals — every flyable aircraft ships a real model
above — but they remain in the codebase as the documented
fallback shapes for their classes, and the generic placeholder
(the airliner) is still what renders if a model file ever fails
to load:

- **Airliner** — `createAirplane()` in
  `src/game/createAirplane.ts`: primitives-built airliner (tube
  fuselage, window rows, cheatline, underwing engines, winglets).
- **Fighter** — `createFighterJet()` in `src/game/createFighter.ts`:
  grey delta-wing jet with canted twin tails, side intakes, twin
  exhausts and a pitot probe.

Both are normalized at build time to their config's fitted
length (11 m × the config's `scale`) with the underside on the
gear contact — see `normalizeProceduralModel` in
`src/game/aircraftModel.ts`. Which visual an aircraft uses is
decided by `modelSourceFor(config)`: a `modelPath` wins, then
`proceduralModel`, then the generic placeholder.

## Supplying different glTF/GLB models (manual step)

To swap any aircraft's model for another one:

1. Obtain a model you have the rights to use (check its license;
   this project only ships CC-BY or original content), in
   `.glb`/`.gltf` form loadable by Babylon.js.
2. Convert a binary `.glb` to embedded-text `.gltf` (the repo
   stores assets as text) and put it under `public/models/`.
3. In `src/game/aircraftConfigs.ts`, set that aircraft's
   `modelPath` to the file's URL path.
4. The loader measures and fits the model automatically
   (uniform scale to the config's length, underside on the gear
   contact, nose derived from propellers when present). If a
   prop-less model ends up facing backwards, set the config's
   `modelYawDeg` to `180`.
5. Credit the model here, following the entries above.
