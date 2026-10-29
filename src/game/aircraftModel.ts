import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

/**
 * Phase 8 — glTF aircraft model, kept fully separate from the flight
 * physics. The simulation moves a plain TransformNode (the aircraft
 * root from createAirplane); this module only swaps what that root
 * LOOKS like:
 *
 *   - The primitive placeholder is built first and flies immediately.
 *   - The model loads asynchronously; on success the placeholder is
 *     hidden and the model takes its place under a dedicated
 *     model-root node. On any failure the placeholder simply stays —
 *     the sim never depends on the asset.
 *
 * Fitting is measured, not assumed: the loaded hierarchy's bounds
 * and the two propeller positions are read back in aircraft-root
 * space (pose-independent), the nose direction is derived from the
 * propellers (they sit near the nose — the tail reaches much further
 * from the prop plane than the nose does), and the model root gets
 * the yaw + uniform scale + offset that put an 11 m aircraft with
 * its underside exactly at the physics gear contact (root −2.25 m,
 * the GEAR_DEPTH the controller already uses). Physics dimensions
 * never read anything from the model.
 */

const MODEL_URL = "/models/cesium-air.gltf";
const TARGET_LENGTH = 11; // metres, nose to tail
const GEAR_DROP = 2.25; // model underside below the aircraft root (== controller GEAR_DEPTH)

/** Bounds of a node hierarchy expressed in aircraft-root space. */
function boundsInRootSpace(
  hierarchyRoot: TransformNode,
  aircraftRoot: TransformNode,
): { min: Vector3; max: Vector3 } {
  hierarchyRoot.computeWorldMatrix(true);
  const { min, max } = hierarchyRoot.getHierarchyBoundingVectors(true);
  // Convert world bounds into aircraft-root space so the fit does
  // not depend on where the aircraft happens to be when the load
  // finishes (it may already be airborne).
  const inv = aircraftRoot.getWorldMatrix().clone();
  inv.invert();
  const corners: Vector3[] = [];
  for (const x of [min.x, max.x])
    for (const y of [min.y, max.y])
      for (const z of [min.z, max.z]) corners.push(Vector3.TransformCoordinates(new Vector3(x, y, z), inv));
  const lo = new Vector3(
    Math.min(...corners.map((c) => c.x)),
    Math.min(...corners.map((c) => c.y)),
    Math.min(...corners.map((c) => c.z)),
  );
  const hi = new Vector3(
    Math.max(...corners.map((c) => c.x)),
    Math.max(...corners.map((c) => c.y)),
    Math.max(...corners.map((c) => c.z)),
  );
  return { min: lo, max: hi };
}

function toRootSpace(p: Vector3, aircraftRoot: TransformNode): Vector3 {
  const inv = aircraftRoot.getWorldMatrix().clone();
  inv.invert();
  return Vector3.TransformCoordinates(p, inv);
}

export async function loadAircraftModel(
  scene: Scene,
  aircraftRoot: TransformNode,
  addShadowCaster: (mesh: AbstractMesh) => void,
  url: string = MODEL_URL,
): Promise<boolean> {
  // Snapshot the placeholder meshes before the model exists.
  const placeholders = aircraftRoot.getChildMeshes(false);
  try {
    const result = await SceneLoader.ImportMeshAsync("", "", url, scene);
    const gltfRoot = result.meshes[0];
    if (!gltfRoot) throw new Error("Model file contained no meshes");

    const container = new TransformNode("aircraft-model", scene);
    container.parent = aircraftRoot;
    gltfRoot.parent = container;

    // Force every world matrix in the new hierarchy to be computed
    // NOW (parents first). Freshly loaded nodes otherwise report
    // stale positions — the propellers' absolute positions came
    // back in unconverted file space, which flipped the measured
    // nose direction and put the first fitted model on backwards.
    aircraftRoot.computeWorldMatrix(true);
    for (const node of [container, ...container.getDescendants(false)]) {
      if (node instanceof TransformNode) node.computeWorldMatrix(true);
    }

    // --- Measure in root space ---
    let bounds = boundsInRootSpace(container, aircraftRoot);

    // --- Find the nose: propellers are spread along the span and
    // mounted near the nose, so the prop plane sits much closer to
    // the nose end of the airframe than to the tail end. ---
    // The propeller NODES (not their "_primitive" meshes — those
    // share one position per prop and read as a single point).
    // Dedupe by position and keep the two farthest apart.
    const propCandidates = [...result.meshes, ...result.transformNodes].filter(
      (n) => /prop/i.test(n.name) && !/primitive/i.test(n.name),
    );
    const propPoints: Vector3[] = [];
    for (const node of propCandidates) {
      const p = toRootSpace(node.getAbsolutePosition(), aircraftRoot);
      if (!propPoints.some((q) => Vector3.Distance(q, p) < 0.5)) propPoints.push(p);
    }
    let propNodes: Vector3[] = [];
    if (propPoints.length >= 2) {
      let best = -1;
      for (let i = 0; i < propPoints.length; i++)
        for (let j = i + 1; j < propPoints.length; j++) {
          const d = Vector3.Distance(propPoints[i], propPoints[j]);
          if (d > best) {
            best = d;
            propNodes = [propPoints[i], propPoints[j]];
          }
        }
    }
    let noseDir = new Vector3(0, 0, -1); // fallback: loaded forward is already -Z
    let length = bounds.max.z - bounds.min.z;
    if (propNodes.length >= 2) {
      const [p1, p2] = propNodes;
      const span = p2.subtract(p1);
      span.y = 0;
      if (span.length() > 0.01) {
        span.normalize();
        // Forward axis: horizontal, perpendicular to the span.
        const fwd = new Vector3(-span.z, 0, span.x);
        const corners: Vector3[] = [];
        for (const x of [bounds.min.x, bounds.max.x])
          for (const z of [bounds.min.z, bounds.max.z]) corners.push(new Vector3(x, 0, z));
        const dots = corners.map((c) => Vector3.Dot(c, fwd));
        const fMin = Math.min(...dots);
        const fMax = Math.max(...dots);
        const propPlane = Vector3.Dot(p1.add(p2).scale(0.5), fwd);
        const noseIsPlusF = fMax - propPlane < propPlane - fMin;
        noseDir = noseIsPlusF ? fwd : fwd.scale(-1);
        length = fMax - fMin;
      }
    }
    if (!(length > 0.1)) throw new Error("Could not measure the model");

    // --- Fit: yaw the nose to -Z, scale to target length ---
    container.rotation.y = Math.atan2(noseDir.x, -noseDir.z);
    container.scaling.setAll(TARGET_LENGTH / length);

    // Re-measure with yaw+scale applied, then centre horizontally
    // and drop the underside exactly onto the gear contact.
    bounds = boundsInRootSpace(container, aircraftRoot);
    const cx = (bounds.min.x + bounds.max.x) / 2;
    const cz = (bounds.min.z + bounds.max.z) / 2;
    container.position.set(-cx, -GEAR_DROP - bounds.min.y, -cz);

    // Verify the fit before showing it: the measured nose, pushed
    // through the container's transform, must point along -Z in
    // root space. (A warning only — the visual check is the judge.)
    {
      const inv = aircraftRoot.getWorldMatrix().clone();
      inv.invert();
      const world = container.getWorldMatrix().multiply(inv);
      const fitted = Vector3.TransformNormal(noseDir, world).normalize();
      if (Math.abs(fitted.z + 1) > 0.2 || Math.abs(fitted.x) > 0.2) {
        console.warn("Aircraft model fit looks wrong:", fitted.toString());
      }
    }

    // --- Presentation: shadows + spinning propellers ---
    for (const mesh of result.meshes) {
      if (mesh.getTotalVertices() > 0) {
        mesh.receiveShadows = true;
        addShadowCaster(mesh);
      }
    }
    for (const group of result.animationGroups) {
      group.start(true);
      group.speedRatio = 0.8;
    }

    // Hide the placeholder (hierarchy-disabled: no render, no shadow).
    const group = new TransformNode("aircraft-placeholder", scene);
    group.parent = aircraftRoot;
    for (const mesh of placeholders) mesh.parent = group;
    group.setEnabled(false);
    return true;
  } catch (err) {
    // The placeholder stays — the sim must never depend on an asset.
    console.warn("Aircraft model failed to load; keeping the placeholder.", err);
    return false;
  }
}
