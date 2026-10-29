import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { createIsland } from "../src/game/createIsland";
import { createAirport } from "../src/game/createAirport";
import { createAirplane } from "../src/game/createAirplane";
import { createCheckpointMarkers } from "../src/game/checkpointMarkers";
import { MissionRun, checkpointVisuals } from "../src/game/missions";
import { applyWeatherToScene } from "../src/game/environment";

try {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  console.log("scene ok");
  createIsland(scene);
  console.log("island ok, meshes:", scene.meshes.length);
  createAirport(scene);
  console.log("airport ok, meshes:", scene.meshes.length);
  createAirplane(scene);
  console.log("airplane ok, meshes:", scene.meshes.length);
  // Phase 9.1: the real checkpoint guidance set (rings + route +
  // beacon + badges), built by the same module FlightScene uses.
  const markers = createCheckpointMarkers(scene, checkpointVisuals(new MissionRun("checkpoints")));
  markers.update(1.25); // exercise the pulse animation path
  console.log("checkpoints ok, marker meshes:", markers.meshCount, "scene meshes:", scene.meshes.length);
  markers.dispose();
  console.log("checkpoints disposed, scene meshes:", scene.meshes.length);
  // Phase 10: weather presets apply their fog/sky to the real scene
  // (the cloud layer was removed at Jeet's request — fog + sky only).
  for (const id of ["clear", "cloudy", "storm"] as const) {
    const preset = applyWeatherToScene(scene, id);
    if (Math.abs(scene.fogDensity - preset.fogDensity) > 1e-9) {
      throw new Error(`weather ${id}: fog density not applied`);
    }
    console.log(`weather ${id} ok, fog density:`, scene.fogDensity);
  }
  // Force geometry/material validation paths that run at first render
  new FreeCamera("test-camera", new Vector3(0, 4, 82), scene);
  scene.render();
  console.log("render pass ok");
} catch (err) {
  console.error("WORLD BUILD FAILED:", err);
  process.exit(1);
}
