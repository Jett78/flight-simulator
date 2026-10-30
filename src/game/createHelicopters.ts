import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { Obstacle } from "./obstacles";

/**
 * Parked helicopters on the apron (Jeet, v0.21.0: "add
 * helicopter in taxiway"). Two CC-BY Poly Pizza models — see
 * ASSETS.md — placed as static scenery beside the taxiway.
 *
 * Placement is data-first: the spots below are fixed, so the
 * collision boxes are known synchronously (heliObstacles) and
 * the visual models stream in whenever they load. The files
 * are bundled same-origin in public/models (tiny, local), and
 * the placement is verified in the browser before deploy.
 */

export interface HeliSpot {
  name: string;
  modelPath: string;
  /** Apron-top ground height (the concrete slab's top face). */
  groundY: number;
  x: number;
  z: number;
  /** Final on-ground length of the model (rotor disc ~ same). */
  targetLength: number;
  /** Fuselage width used for the collision footprint. */
  width: number;
  /** Facing: degrees of yaw applied to the fitted model. */
  yawDeg: number;
  /**
   * Extra yaw (deg) that turns the model's file-forward to the
   * sim's -Z. Determined by inspecting each file in-game, the
   * same way the aircraft fits were pinned down.
   */
  fileYawDeg: number;
}

export const HELI_SPOTS: HeliSpot[] = [
  {
    name: "helicopter-1",
    modelPath: "/models/heli-grey.gltf",
    groundY: 0.12,
    x: -80,
    z: 44,
    targetLength: 11.5,
    width: 3.4,
    yawDeg: -35,
    fileYawDeg: 0,
  },
  {
    name: "helicopter-2",
    modelPath: "/models/heli-red.gltf",
    groundY: 0.12,
    x: -80,
    z: 14,
    targetLength: 10.5,
    width: 3.2,
    yawDeg: 30,
    fileYawDeg: 0,
  },
];

/** Synchronous collision boxes for the parked helicopters. */
export function heliObstacles(): Obstacle[] {
  return HELI_SPOTS.map((s) => {
    const yaw = (s.yawDeg * Math.PI) / 180;
    const hl = s.targetLength / 2;
    const hw = s.width / 2;
    const hx = Math.abs(Math.cos(yaw)) * hl + Math.abs(Math.sin(yaw)) * hw;
    const hz = Math.abs(Math.sin(yaw)) * hl + Math.abs(Math.cos(yaw)) * hw;
    return {
      kind: "box" as const,
      name: s.name,
      minX: s.x - hx,
      maxX: s.x + hx,
      minZ: s.z - hz,
      maxZ: s.z + hz,
      baseY: 0,
      topY: 3.8,
    };
  });
}

/**
 * Load + place the helicopter models. Never throws: on any
 * failure the apron simply stays empty.
 */
export async function loadHelicopters(
  scene: Scene,
  addShadowCaster: (mesh: Mesh) => void,
): Promise<void> {
  for (const spot of HELI_SPOTS) {
    try {
      const result = await SceneLoader.ImportMeshAsync("", "", spot.modelPath, scene);
      const gltfRoot = result.meshes[0];
      if (!gltfRoot) continue;
      const holder = new TransformNode(spot.name, scene);
      holder.position = new Vector3(spot.x, spot.groundY, spot.z);
      holder.rotation.y = ((spot.yawDeg + spot.fileYawDeg) * Math.PI) / 180;
      gltfRoot.parent = holder;

      // Measure, scale to the target length, centre on the
      // holder and drop the underside onto the apron — all in
      // holder-local space via the inverse world matrix, the
      // same discipline as the aircraft model fit.
      const localBounds = () => {
        holder.computeWorldMatrix(true);
        const world = gltfRoot.getHierarchyBoundingVectors(true);
        const inv = holder.getWorldMatrix().clone();
        inv.invert();
        const min = new Vector3(Infinity, Infinity, Infinity);
        const max = new Vector3(-Infinity, -Infinity, -Infinity);
        for (const cx of [world.min.x, world.max.x])
          for (const cy of [world.min.y, world.max.y])
            for (const cz of [world.min.z, world.max.z]) {
              const p = Vector3.TransformCoordinates(new Vector3(cx, cy, cz), inv);
              min.minimizeInPlace(p);
              max.maximizeInPlace(p);
            }
        return { min, max };
      };
      let bounds = localBounds();
      const size = bounds.max.subtract(bounds.min);
      const length = Math.max(size.x, size.z);
      if (!(length > 0)) continue;
      gltfRoot.scaling.setAll(spot.targetLength / length);
      bounds = localBounds();
      gltfRoot.position.x -= (bounds.min.x + bounds.max.x) / 2;
      gltfRoot.position.z -= (bounds.min.z + bounds.max.z) / 2;
      gltfRoot.position.y -= bounds.min.y;

      for (const mesh of gltfRoot.getChildMeshes(false)) {
        mesh.receiveShadows = true;
        addShadowCaster(mesh as Mesh);
      }
      for (const group of result.animationGroups) group.stop();
    } catch {
      // Scenery is optional — a failed load leaves the apron bare.
    }
  }
}
