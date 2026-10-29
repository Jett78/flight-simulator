import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Material } from "@babylonjs/core/Materials/material";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Scene } from "@babylonjs/core/scene";
import type { CheckpointVisual } from "./missions";

/**
 * Phase 9.1 — 3D checkpoint markers.
 *
 * The original rings alone were too easy to lose against the island:
 * a ring 600 m away is only a few pixels wide, and there was no way
 * to tell where the *next* ring was after passing one. This module
 * builds the full guidance set for a checkpoint run:
 *
 * - the rings themselves (gold = next, green = done, blue = later),
 * - a translucent route ribbon joining spawn -> ring 1 -> ... -> 5,
 *   with the leg to the next ring drawn thick and gold,
 * - a tall pulsing light pillar (beacon) through the next ring, and
 * - a numbered badge floating at each ring centre, always facing
 *   the camera.
 *
 * Phase 12.1: the NEXT ring is deliberately oversized (thicker torus,
 * bigger badge, wider/brighter beam) so it reads from 500+ m away —
 * the original sizes were easy to lose against the island at range.
 * Later rings keep their smaller, dimmer look.
 *
 * All materials ignore fog so a distant active marker stays readable.
 * The handle owns every mesh/material/texture it creates; dispose()
 * removes the whole set. update(t) drives the pulse animation.
 */

export interface CheckpointMarkerHandle {
  update: (timeSeconds: number) => void;
  dispose: () => void;
  readonly meshCount: number;
}

interface AnimatedPart {
  mesh: AbstractMesh;
  kind: "ring" | "beacon" | "badge";
  baseY: number;
  material: StandardMaterial | null;
}

const SPAWN = new Vector3(0, 2.41, 68);

function markerMaterial(
  scene: Scene,
  name: string,
  emissive: Color3,
  diffuse: Color3,
  alpha: number,
): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.emissiveColor = emissive;
  mat.diffuseColor = diffuse;
  mat.alpha = alpha;
  mat.fogEnabled = false;
  if (alpha < 1) mat.transparencyMode = 2; // alpha blend
  return mat;
}

function makeBadgeTexture(
  scene: Scene,
  index: number,
  state: CheckpointVisual["state"],
): BaseTexture | null {
  try {
    const tex = new DynamicTexture(
      `checkpoint-badge-${index}`,
      { width: 160, height: 160 },
      scene,
      true,
    );
    // Babylon's canvas-context type omits the text alignment props;
    // the runtime object is a real 2D context.
    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 160, 160);
    ctx.beginPath();
    ctx.arc(80, 80, 62, 0, Math.PI * 2);
    ctx.fillStyle =
      state === "active" ? "#ffb400" : state === "completed" ? "#2fbf71" : "#2b6cb0";
    ctx.fill();
    ctx.lineWidth = 9;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.stroke();
    ctx.fillStyle = state === "active" ? "#081220" : "#ffffff";
    ctx.font = "700 78px system-ui, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(state === "completed" ? "✓" : String(index + 1), 80, 84);
    tex.hasAlpha = true;
    tex.update();
    return tex;
  } catch {
    // Canvas unavailable (some headless environments): badges are a
    // visual aid only — the rings/beacon/route still guide the pilot.
    return null;
  }
}

export function createCheckpointMarkers(
  scene: Scene,
  visuals: CheckpointVisual[],
): CheckpointMarkerHandle {
  const meshes: AbstractMesh[] = [];
  const materials: Material[] = [];
  const textures: BaseTexture[] = [];
  const animated: AnimatedPart[] = [];

  const track = <T extends AbstractMesh>(mesh: T): T => {
    mesh.isPickable = false;
    meshes.push(mesh);
    return mesh;
  };
  const trackMat = <T extends StandardMaterial>(mat: T): T => {
    materials.push(mat);
    return mat;
  };

  // --- Route ribbon: spawn -> each ring, in order -------------------
  const points = [SPAWN, ...visuals.map((v) => new Vector3(v.x, v.y, v.z))];
  for (let i = 0; i < visuals.length; i++) {
    const from = points[i];
    const to = points[i + 1];
    const dir = to.subtract(from);
    const length = dir.length();
    if (length < 1) continue;
    const state = visuals[i].state;
    const segment = track(
      MeshBuilder.CreateCylinder(
        `checkpoint-route-${i}`,
        {
          height: length,
          diameterTop: state === "active" ? 2.4 : 1.1,
          diameterBottom: state === "active" ? 2.4 : 1.1,
          tessellation: 8,
        },
        scene,
      ),
    );
    segment.position.copyFromFloats(
      (from.x + to.x) / 2,
      (from.y + to.y) / 2,
      (from.z + to.z) / 2,
    );
    const quat = new Quaternion();
    Quaternion.FromUnitVectorsToRef(Vector3.Up(), dir.normalize(), quat);
    segment.rotationQuaternion = quat;
    segment.material = trackMat(
      markerMaterial(
        scene,
        `checkpoint-route-mat-${i}`,
        state === "active"
          ? new Color3(1, 0.66, 0.1)
          : state === "completed"
            ? new Color3(0.16, 0.75, 0.4)
            : new Color3(0.25, 0.45, 0.75),
        new Color3(0.08, 0.08, 0.08),
        state === "active" ? 0.5 : state === "completed" ? 0.26 : 0.16,
      ),
    );
  }

  // --- Rings, badges, and the active beacon --------------------------
  visuals.forEach((v, i) => {
    const ring = track(
      MeshBuilder.CreateTorus(
        `checkpoint-ring-${i}`,
        {
          diameter: v.r * 2,
          thickness: v.state === "active" ? 5.0 : 2.3,
          tessellation: 44,
        },
        scene,
      ),
    );
    ring.position.set(v.x, v.y, v.z);
    ring.rotation.y = v.yaw;
    ring.material = trackMat(
      markerMaterial(
        scene,
        `checkpoint-ring-mat-${i}`,
        v.state === "active"
          ? new Color3(1, 0.72, 0.12)
          : v.state === "completed"
            ? new Color3(0.18, 0.85, 0.4)
            : new Color3(0.3, 0.55, 0.95),
        new Color3(0.1, 0.1, 0.1),
        v.state === "active" ? 1 : v.state === "completed" ? 0.8 : 0.85,
      ),
    );
    if (v.state === "active") {
      animated.push({ mesh: ring, kind: "ring", baseY: v.y, material: null });
    }

    // Numbered badge at the ring centre, always facing the camera.
    const tex = makeBadgeTexture(scene, i, v.state);
    if (tex) {
      textures.push(tex);
      const size = v.state === "active" ? 32 : 18;
      const badge = track(
        MeshBuilder.CreatePlane(`checkpoint-badge-${i}`, { width: size, height: size }, scene),
      );
      badge.position.set(v.x, v.y, v.z);
      badge.billboardMode = AbstractMesh.BILLBOARDMODE_ALL;
      const mat = trackMat(new StandardMaterial(`checkpoint-badge-mat-${i}`, scene));
      mat.diffuseTexture = tex;
      mat.emissiveTexture = tex;
      mat.emissiveColor = new Color3(1, 1, 1);
      mat.diffuseColor = new Color3(0, 0, 0);
      mat.alpha = 0.97;
      mat.transparencyMode = 2;
      mat.fogEnabled = false;
      mat.backFaceCulling = false;
      badge.material = mat;
      if (v.state === "active") {
        animated.push({ mesh: badge, kind: "badge", baseY: v.y, material: null });
      }
    }

    // Light pillar through the NEXT ring only: visible across the map.
    if (v.state === "active") {
      const beacon = track(
        MeshBuilder.CreateCylinder(
          `checkpoint-beacon-${i}`,
          { height: Math.max(v.y, 1), diameterTop: 16, diameterBottom: 16, tessellation: 20 },
          scene,
        ),
      );
      beacon.position.set(v.x, v.y / 2, v.z);
      const mat = trackMat(
        markerMaterial(
          scene,
          `checkpoint-beacon-mat-${i}`,
          new Color3(1, 0.68, 0.12),
          new Color3(0.2, 0.13, 0.02),
          0.22,
        ),
      );
      beacon.material = mat;
      animated.push({ mesh: beacon, kind: "beacon", baseY: v.y / 2, material: mat });
    }
  });

  return {
    meshCount: meshes.length,
    update(timeSeconds: number) {
      const pulse = Math.sin(timeSeconds * 3);
      for (const part of animated) {
        if (part.kind === "ring") {
          part.mesh.scaling.setAll(1 + 0.045 * pulse);
        } else if (part.kind === "beacon" && part.material) {
          part.material.alpha = 0.20 + 0.07 * (pulse * 0.5 + 0.5);
        } else if (part.kind === "badge") {
          part.mesh.scaling.setAll(1 + 0.07 * pulse);
        }
      }
    },
    dispose() {
      for (const mesh of meshes) mesh.dispose();
      for (const mat of materials) mat.dispose();
      for (const tex of textures) tex.dispose();
      meshes.length = 0;
      materials.length = 0;
      textures.length = 0;
      animated.length = 0;
    },
  };
}
