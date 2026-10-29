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
