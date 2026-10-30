import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import type { AircraftConfig } from "./aircraftConfigs";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
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

/**
 * Multi-aircraft Phase 4: where an aircraft's visuals come from.
 * A supplied glTF wins; otherwise the config's built-in
 * procedural model; otherwise the generic placeholder (which is
 * also the in-flight fallback while a glTF streams in, and the
 * permanent fallback if it fails). One resolver, used by both
 * FlightScene and the tests, so they can never disagree.
 */
export type AircraftModelSource =
  | { kind: "gltf"; path: string }
  | { kind: "procedural"; builder: "airliner" | "fighter" }
  | { kind: "placeholder" };

export function modelSourceFor(cfg: AircraftConfig): AircraftModelSource {
  if (cfg.modelPath) return { kind: "gltf", path: cfg.modelPath };
  if (cfg.proceduralModel) return { kind: "procedural", builder: cfg.proceduralModel };
  return { kind: "placeholder" };
}

/**
 * Fit a procedurally built model under a container, the same
 * normalization the GLB path performs: uniform scale so the
 * airframe is targetLength long, centred horizontally on the
 * aircraft root, underside resting exactly on the gear contact
 * (root −2.25 m). Procedural builders author in the game's
 * convention already (nose −Z), so no yaw correction is needed.
 */
export function normalizeProceduralModel(
  container: TransformNode,
  aircraftRoot: TransformNode,
  targetLength: number,
): void {
  let bounds = boundsInRootSpace(container, aircraftRoot);
  const length = bounds.max.z - bounds.min.z;
  if (!(length > 0.1)) return;
  container.scaling.setAll(targetLength / length);
  bounds = boundsInRootSpace(container, aircraftRoot);
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cz = (bounds.min.z + bounds.max.z) / 2;
  container.position.set(-cx, -GEAR_DROP - bounds.min.y, -cz);
  computeModelGroundProfile(container, aircraftRoot);
}

// --- Ground-rotation clearance (v0.21.0) -----------------------
//
// The physics pitches the aircraft about its root (the centre),
// but a real aircraft rotates about its main gear. On the
// fighter that difference buried the tail and its underwing
// stores up to ~2.4 m INSIDE the runway during takeoff rotation
// (measured in-game; Jeet reported "some part of plane goes
// inside runway"). The fix is visual and exact: at fit time we
// record the model's low sample points and its gear contact
// patch; each grounded frame the model container is offset by
// the translation that makes the pitch a rotation ABOUT THE
// GEAR PIVOT, plus a residual lift so no sampled point can dip
// below the gear contact plane. In the air the offset is zero.

export interface ModelGroundProfile {
  /** Low airframe sample points in aircraft-root space. */
  points: Array<{ y: number; z: number }>;
  /** Z of the main-gear contact patch (the rotation pivot). */
  pivotZ: number;
  /** The container's fitted position; offsets add onto it. */
  basePosition: Vector3;
}

const groundProfiles = new WeakMap<TransformNode, ModelGroundProfile>();

export function getModelGroundProfile(
  container: TransformNode,
): ModelGroundProfile | undefined {
  return groundProfiles.get(container);
}

/**
 * Sample the fitted model's low vertices (root space), find the
 * gear contact patch, and stash the ground profile on the
 * container. Call once, after the fit's final position is set.
 */
export function computeModelGroundProfile(
  container: TransformNode,
  aircraftRoot: TransformNode,
): ModelGroundProfile {
  container.computeWorldMatrix(true);
  const sampled: Vector3[] = [];
  for (const mesh of container.getChildMeshes(false)) {
    const data = mesh.getVerticesData("position");
    if (!data || data.length < 3) continue;
    const wm = mesh.getWorldMatrix();
    const total = Math.floor(data.length / 3);
    const stride = Math.max(1, Math.floor(total / 1500));
    const v = new Vector3(0, 0, 0);
    for (let i = 0; i < total; i += stride) {
      v.set(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]);
      sampled.push(toRootSpace(Vector3.TransformCoordinates(v, wm), aircraftRoot));
    }
  }
  let minY = Infinity;
  for (const p of sampled) if (p.y < minY) minY = p.y;
  if (!isFinite(minY)) minY = -GEAR_DROP;
  // Contact patch: the lowest points are the gear/stores line.
  const patch = sampled.filter((p) => p.y <= minY + 0.3);
  const pivotZ =
    patch.length > 0 ? patch.reduce((s, p) => s + p.z, 0) / patch.length : 0;
  const low = sampled.filter((p) => p.y <= minY + 1.6);
  const stride = Math.max(1, Math.floor(low.length / 500));
  const points: Array<{ y: number; z: number }> = [];
  for (let i = 0; i < low.length; i += stride) points.push({ y: low[i].y, z: low[i].z });
  const profile: ModelGroundProfile = {
    points,
    pivotZ,
    basePosition: container.position.clone(),
  };
  groundProfiles.set(container, profile);
  return profile;
}

/**
 * The container offset (root space) that turns a pitch about
 * the root into a rotation about the gear pivot, with a
 * residual lift guaranteeing no sampled point ends below the
 * gear contact plane (−GEAR_DROP). Pure — unit-tested.
 */
export function groundOffsetForPitch(
  profile: ModelGroundProfile,
  pitchRad: number,
): { dy: number; dz: number } {
  const cos = Math.cos(pitchRad);
  const sin = Math.sin(pitchRad);
  const py = -GEAR_DROP;
  const pz = profile.pivotZ;
  const ry = py * cos - pz * sin;
  const rz = py * sin + pz * cos;
  let dy = py - ry;
  const dz = pz - rz;
  let minY = Infinity;
  for (const p of profile.points) {
    const y = p.y * cos - p.z * sin + dy;
    if (y < minY) minY = y;
  }
  if (isFinite(minY) && minY < py) dy += py - minY;
  return { dy, dz };
}

export async function loadAircraftModel(
  scene: Scene,
  aircraftRoot: TransformNode,
  addShadowCaster: (mesh: AbstractMesh) => void,
  url: string = MODEL_URL,
  /** Multi-aircraft Phase 1: config scale — fitted length multiplier (1 = the stock 11 m). */
  scaleFactor: number = 1,
  /** Phase 4: extra yaw (degrees) for supplied models whose nose the fit reads backwards. */
  extraYawDeg: number = 0,
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
    container.rotation.y = Math.atan2(noseDir.x, -noseDir.z) + (extraYawDeg * Math.PI) / 180;
    container.scaling.setAll((TARGET_LENGTH * scaleFactor) / length);

    // Re-measure with yaw+scale applied, then centre horizontally
    // and drop the underside exactly onto the gear contact.
    bounds = boundsInRootSpace(container, aircraftRoot);
    const cx = (bounds.min.x + bounds.max.x) / 2;
    const cz = (bounds.min.z + bounds.max.z) / 2;
    container.position.set(-cx, -GEAR_DROP - bounds.min.y, -cz);
    computeModelGroundProfile(container, aircraftRoot);

    // Verify the fit before showing it: the measured nose, pushed
    // through the container's transform, must point along -Z in
    // root space — after undoing the INTENTIONAL extraYaw
    // correction, which by design turns the file's forward away
    // from -Z first (a warning only — the visual check is the
    // judge; without the undo, every yaw-corrected model warned).
    {
      const inv = aircraftRoot.getWorldMatrix().clone();
      inv.invert();
      const world = container.getWorldMatrix().multiply(inv);
      const fitted = Vector3.TransformNormal(noseDir, world).normalize();
      const uncorrected = Vector3.TransformNormal(
        fitted,
        Matrix.RotationY((-extraYawDeg * Math.PI) / 180),
      );
      if (Math.abs(uncorrected.z + 1) > 0.2 || Math.abs(uncorrected.x) > 0.2) {
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
