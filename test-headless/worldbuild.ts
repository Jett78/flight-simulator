import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { createIsland } from "../src/game/createIsland";
import { createAirport } from "../src/game/createAirport";
import { createAirplane } from "../src/game/createAirplane";

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
  // Force geometry/material validation paths that run at first render
  new FreeCamera("test-camera", new Vector3(0, 4, 82), scene);
  scene.render();
  console.log("render pass ok");
} catch (err) {
  console.error("WORLD BUILD FAILED:", err);
  process.exit(1);
}
