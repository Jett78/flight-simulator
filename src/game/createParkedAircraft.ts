import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import { loadAircraftModel } from "./aircraftModel";
import { getAircraftConfig } from "./aircraftConfigs";
import type { Obstacle } from "./obstacles";

/**
 * Parked aircraft (v0.22.0, Jeet: "add airplanes there too").
 * The same three models the player flies, parked as scenery:
 * a Cesium Air and a Falcon on the apron, a 747 on the remote
 * stand. Each is fitted by the very same loader the player's
 * aircraft uses (measured fit, config yaw), under a root placed
 * at the spot — so they look identical to the flyable ones.
 *
 * Spots are fixed data, so collision boxes are synchronous
 * (parkedObstacles); the models stream in async like the
 * helicopters'. A parked Cesium's propellers would spin (the
 * loader starts the model's animation groups), so after each
 * load we stop any animation group targeting that root.
 */

export interface ParkedSpot {
  name: string;
  configId: string;
  x: number;
  z: number;
  /** Top of the concrete the aircraft sits on. */
  groundY: number;
  /** Root yaw in degrees (0 = nose north, -90 = nose east). */
  facingDeg: number;
  length: number;
  span: number;
  topY: number;
}

export const PARKED_SPOTS: ParkedSpot[] = [
  {
    name: "parked-cesium",
    configId: "cesium-air",
    x: -62,
    z: 40,
    groundY: 0.12,
    facingDeg: -65,
    length: 11,
    span: 13.2,
    topY: 4.8,
  },
  {
    name: "parked-falcon",
    configId: "falcon-f1",
    x: -64,
    z: 16,
    groundY: 0.12,
    facingDeg: -80,
    length: 14.85,
    span: 11.5,
    topY: 4.4,
  },
  {
    name: "parked-jet",
    configId: "skyliner-200",
    x: 58,
    z: 94,
    groundY: 0.12,
    facingDeg: 90,
    length: 28.6,
    span: 24.5,
    topY: 7.5,
  },
];

/** Synchronous collision boxes for the parked aircraft. */
export function parkedObstacles(): Obstacle[] {
  return PARKED_SPOTS.map((s) => {
    const yaw = (s.facingDeg * Math.PI) / 180;
    const hl = s.length / 2;
    const hw = s.span / 2;
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
      topY: s.topY,
    };
  });
}

/** Load + park the aircraft. Never throws. */
export async function loadParkedAircraft(
  scene: Scene,
  addShadowCaster: (mesh: AbstractMesh) => void,
): Promise<void> {
  for (const spot of PARKED_SPOTS) {
    try {
      const cfg = getAircraftConfig(spot.configId);
      if (!cfg.modelPath) continue;
      const root = new TransformNode(spot.name, scene);
      // The fit drops the model's underside to root −2.25 (the
      // gear contact), so the root rides 2.25 above the concrete.
      root.position.set(spot.x, spot.groundY + 2.25, spot.z);
      // IMPORTANT: the root must stay at rotation 0 while the
      // fit runs — the fit measures world AABBs back into root
      // space, which inflates badly under a pre-rotated root
      // (a -65° root halved the first parked Cesium). The model
      // is centred on the root, so facing is applied after.
      const loaded = await loadAircraftModel(
        scene,
        root,
        addShadowCaster,
        cfg.modelPath,
        cfg.scale,
        cfg.modelYawDeg ?? 0,
      );
      if (!loaded) continue;
      root.rotation.y = (spot.facingDeg * Math.PI) / 180;
      // Parked means parked: stop this aircraft's animations
      // (the Cesium's propellers) without touching the player's.
      for (const group of scene.animationGroups) {
        const targetsParked = group.targetedAnimations.some(
          (ta) => ta.target === root || (ta.target as AbstractMesh).isDescendantOf?.(root),
        );
        if (targetsParked) group.stop();
      }
    } catch {
      // Scenery is optional — a failed load leaves the spot empty.
    }
  }
}
