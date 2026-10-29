import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { createIsland } from "../src/game/createIsland";
import { createAirport } from "../src/game/createAirport";
import { createAirplane } from "../src/game/createAirplane";
import { MissionRun, checkpointVisuals } from "../src/game/missions";

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
  // Phase 9: checkpoint rings, built exactly as FlightScene builds them
  for (const v of checkpointVisuals(new MissionRun("checkpoints"))) {
    const ring = MeshBuilder.CreateTorus(
      "checkpoint",
      { diameter: v.r * 2, thickness: 1.7, tessellation: 40 },
      scene,
    );
    ring.position.set(v.x, v.y, v.z);
    ring.rotation.y = v.yaw;
    const mat = new StandardMaterial("checkpointMat", scene);
    mat.emissiveColor = v.active ? new Color3(1, 0.72, 0.15) : new Color3(0.25, 0.45, 0.75);
    ring.material = mat;
  }
  console.log("checkpoints ok, meshes:", scene.meshes.length);
  // Force geometry/material validation paths that run at first render
  new FreeCamera("test-camera", new Vector3(0, 4, 82), scene);
  scene.render();
  console.log("render pass ok");
} catch (err) {
  console.error("WORLD BUILD FAILED:", err);
  process.exit(1);
}
