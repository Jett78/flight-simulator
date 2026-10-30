# Asset credits & licenses

Everything else in the scene (island, runway, buildings, trees,
village, lighthouse, placeholder aircraft) is generated procedurally
in code — no external assets, no paid services, no runtime API calls.

## Aircraft model — `public/models/cesium-air.gltf`

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

## Procedural aircraft — SkyLiner 200 & Falcon F1 (Phase 4)

The other two flyable aircraft are **procedurally built in code**
(no external files, no licenses involved):

- **SkyLiner 200** (commercial jet) — `createAirplane()` in
  `src/game/createAirplane.ts`: the primitives-built airliner
  (tube fuselage, window rows, cheatline, underwing engines,
  winglet tail) that used to be the generic placeholder.
- **Falcon F1** (fighter) — `createFighterJet()` in
  `src/game/createFighter.ts`: grey delta-wing jet with canted
  twin tails, side intakes, twin exhausts and a pitot probe.

Both are normalized at build time to their config's fitted
length (11 m × the config's `scale`) with the underside on the
gear contact — see `normalizeProceduralModel` in
`src/game/aircraftModel.ts`. Which visual an aircraft uses is
decided by `modelSourceFor(config)`: a `modelPath` wins, then
`proceduralModel`, then the generic placeholder.

## Supplying real glTF/GLB models (optional, manual step)

No real jet/fighter model files are bundled — the procedural
aircraft above are the shipped visuals for those two. To replace
either with a real model:

1. Obtain a model you have the rights to use (check its license;
   this project only ships CC-BY or original content), in
   `.glb`/`.gltf` form loadable by Babylon.js.
2. Put the file under `public/models/` (e.g.
   `public/models/skyliner-200.glb`).
3. In `src/game/aircraftConfigs.ts`, set that aircraft's
   `modelPath` to the file's URL path (e.g.
   `"/models/skyliner-200.glb"`) and remove its
   `proceduralModel` entry (optional — `modelPath` wins anyway).
4. The loader measures and fits the model automatically
   (uniform scale to the config's length, underside on the gear
   contact, nose derived from propellers when present). If a
   prop-less model ends up facing backwards, set the config's
   `modelYawDeg` to `180`.
5. Credit the model here, following the Cesium Air entry above.
