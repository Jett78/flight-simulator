import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
// Side-effect import: registers Mesh.createInstance (tree instancing).
// Without it the app throws at runtime — "InstancedMesh needs to be
// imported before as it contains a side-effect required by your
// code" — which white-screened the Phase 5 deploy. TypeScript and
// the production build cannot catch this; test-headless/worldbuild.ts
// now guards it.
import "@babylonjs/core/Meshes/instancedMesh";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Meshes/buffer";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import { createMaterial } from "./materials";

/**
 * Procedural island environment (Phase 5).
 *
 * One analytic height function, `heightAt(x, z)`, drives everything:
 * the terrain mesh displacement, its vertex colours, and the
 * placement of trees / village / lighthouse — so every object sits
 * exactly on the ground by construction.
 *
 * Layout (airport at the origin, runway along Z, departure toward -Z):
 * - A flattened pad around the airport (matches the existing airport
 *   geometry, which assumes y = 0).
 * - Rolling hills that grow with distance from the airport.
 * - Five gaussian mountain peaks (105-165 m) placed away from the
 *   departure corridor.
 * - A coastline at radius ~1080 m falling to a seabed at -7 m, with
 *   the ocean surface at -1.8 m — beaches emerge where the terrain
 *   crosses sea level.
 * - A small flattened village pad on the south-east shore.
 *
 * Performance: one static terrain mesh (~45k triangles), one ocean
 * plane, one sky dome, and trees as two InstancedMeshes (2 draw
 * calls for ~650 trees). Nothing is generated per frame.
 */

export const SEA_LEVEL = -1.8;

const TERRAIN_SIZE = 2800;
const TERRAIN_SUBDIVISIONS = 150;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smoothstep = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
/** Deterministic seeded RNG so the island is identical every load. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Peak {
  x: number;
  z: number;
  h: number;
  r: number;
}
const PEAKS: Peak[] = [
  { x: 620, z: -430, h: 165, r: 330 },
  { x: -680, z: -260, h: 140, r: 300 },
  { x: -430, z: 570, h: 120, r: 280 },
  { x: 540, z: 640, h: 105, r: 260 },
  { x: -360, z: -900, h: 150, r: 340 },
];

/** Village pad centre (south-east shore) and its flattened height. */
export const VILLAGE = { x: 330, z: 700, r: 58, h: 3.4 };

/** Signed distance outside the airport rectangle (0 when inside). */
function airportBoxDistance(x: number, z: number): number {
  const dx = Math.max(Math.abs(x) - 150, 0);
  const dz = Math.max(Math.abs(z) - 175, 0);
  return Math.hypot(dx, dz);
}

/** Terrain height in metres at world (x, z). Pure and deterministic. */
export function heightAt(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const angle = Math.atan2(z, x);
  const coastR = 1080 + 60 * Math.sin(angle * 3 + 1.3) + 30 * Math.sin(angle * 7 - 0.5);
  const coastT = clamp01((coastR - r) / 220); // 1 inland -> 0 offshore

  // Rolling hills, growing with distance from the airport pad
  const dAirport = airportBoxDistance(x, z);
  const hillGrow = smoothstep(dAirport / 520);
  const hills =
    (14 * Math.sin(x * 0.011 + 1.7) * Math.cos(z * 0.009 - 0.6) +
      9 * Math.sin(x * 0.023 - 0.4) * Math.sin(z * 0.019 + 1.2) +
      5 * Math.sin(x * 0.047) * Math.cos(z * 0.041)) *
    hillGrow;

  let mountains = 0;
  for (const p of PEAKS) {
    const d2 = (x - p.x) * (x - p.x) + (z - p.z) * (z - p.z);
    mountains += p.h * Math.exp(-d2 / (p.r * p.r));
  }

  let landH = Math.max(0.5, 1.7 + hills + mountains);
  // Village pad: flatten to a constant height near the shore
  const dVillage = Math.hypot(x - VILLAGE.x, z - VILLAGE.z);
  const villageWeight = 1 - smoothstep((dVillage - VILLAGE.r) / 55);
  landH = landH * (1 - villageWeight) + VILLAGE.h * villageWeight;

  // Blend land into seabed across the coastline
  let h = -7 + (landH + 7) * smoothstep(coastT);

  // Airport pad: perfectly flat y=0 (the airport geometry assumes it)
  const flatWeight = 1 - smoothstep(dAirport / 170);
  h *= 1 - flatWeight;
  return h;
}

/** Terrain colour for a height/slope — stylised low-poly palette. */
function terrainColor(h: number, slope: number, tint: number, out: number[]): void {
  let r: number, g: number, b: number;
  if (h < 0.5) {
    r = 0.72; g = 0.66; b = 0.47; // wet sand
  } else if (h < 2.0) {
    r = 0.85; g = 0.78; b = 0.55; // beach sand
  } else if (h < 34) {
    r = 0.3; g = 0.56; b = 0.26; // grass
  } else if (h < 78) {
    r = 0.21; g = 0.44; b = 0.21; // forest green
  } else {
    r = 0.46; g = 0.43; b = 0.4; // rock
  }
  if (slope > 0.45 && h >= 2) {
    // Steep faces read as rock regardless of height
    const w = Math.min(1, (slope - 0.45) / 0.5);
    r = r * (1 - w) + 0.47 * w;
    g = g * (1 - w) + 0.44 * w;
    b = b * (1 - w) + 0.41 * w;
  }
  if (h > 132) {
    const w = Math.min(1, (h - 132) / 22); // snow caps
    r = r * (1 - w) + 0.93 * w;
    g = g * (1 - w) + 0.95 * w;
    b = b * (1 - w) + 0.97 * w;
  }
  out[0] = r * tint;
  out[1] = g * tint;
  out[2] = b * tint;
}

export interface IslandResult {
  terrain: Mesh;
}

export function createIsland(scene: Scene): IslandResult {
  const rng = mulberry32(1337);

  // ---------- Sky dome (gradient vertex colours, no fog) ----------
  const sky = MeshBuilder.CreateSphere(
    "sky-dome",
    { diameter: 8400, segments: 24 },
    scene,
  );
  {
    const positions = sky.getVerticesData(VertexBuffer.PositionKind);
    const colors: number[] = [];
    if (positions) {
      const c: number[] = [];
      for (let i = 0; i < positions.length; i += 3) {
        const yNorm = positions[i + 1] / 4200; // -1..1
        const t = Math.max(0, Math.min(1, (yNorm + 0.12) / 1.12));
        // horizon (pale) -> zenith (deep blue)
        c[0] = 0.74 + (0.22 - 0.74) * t;
        c[1] = 0.85 + (0.46 - 0.85) * t;
        c[2] = 0.96 + (0.88 - 0.96) * t;
        colors.push(c[0], c[1], c[2], 1);
      }
      sky.setVerticesData(VertexBuffer.ColorKind, colors);
    }
    const skyMat = new StandardMaterial("sky-material", scene);
    skyMat.diffuseColor = new Color3(1, 1, 1);
    skyMat.disableLighting = true;
    skyMat.fogEnabled = false;
    skyMat.backFaceCulling = false; // we view the dome from inside
    sky.material = skyMat;
    sky.useVertexColors = true;
    sky.isPickable = false;
  }

  // ---------- Ocean ----------
  const ocean = MeshBuilder.CreateGround(
    "ocean",
    { width: 9000, height: 9000, subdivisions: 1 },
    scene,
  );
  ocean.position.y = SEA_LEVEL;
  const oceanMat = new StandardMaterial("ocean-material", scene);
  oceanMat.diffuseColor = new Color3(0.11, 0.34, 0.57);
  oceanMat.specularColor = new Color3(0.55, 0.65, 0.75);
  oceanMat.specularPower = 96;
  oceanMat.alpha = 0.94;
  ocean.material = oceanMat;
  ocean.isPickable = false;

  // ---------- Terrain ----------
  const terrain = MeshBuilder.CreateGround(
    "island-terrain",
    {
      width: TERRAIN_SIZE,
      height: TERRAIN_SIZE,
      subdivisionsX: TERRAIN_SUBDIVISIONS,
      subdivisionsY: TERRAIN_SUBDIVISIONS,
    },
    scene,
  );
  {
    const positions = terrain.getVerticesData(VertexBuffer.PositionKind);
    const indices = terrain.getIndices();
    if (!positions || !indices) throw new Error("terrain geometry missing data");
    for (let i = 0; i < positions.length; i += 3) {
      positions[i + 1] = heightAt(positions[i], positions[i + 2]);
    }
    terrain.updateVerticesData(VertexBuffer.PositionKind, positions);

    const normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(positions, indices, normals);
    terrain.updateVerticesData(VertexBuffer.NormalKind, Array.from(normals));

    const colors: number[] = [];
    const c: number[] = [];
    for (let i = 0; i < positions.length; i += 3) {
      const h = positions[i + 1];
      const slope = 1 - normals[i + 1]; // 0 = flat, grows with steepness
      terrainColor(h, slope, 0.94 + rng() * 0.12, c);
      colors.push(c[0], c[1], c[2], 1);
    }
    terrain.setVerticesData(VertexBuffer.ColorKind, colors);
    terrain.useVertexColors = true;

    const terrainMat = new StandardMaterial("terrain-material", scene);
    terrainMat.diffuseColor = new Color3(1, 1, 1);
    terrainMat.specularColor = new Color3(0.06, 0.06, 0.06);
    terrain.material = terrainMat;
    terrain.receiveShadows = true;
    terrain.isPickable = false;
  }

  // ---------- Trees (instanced) ----------
  const trunkBase = MeshBuilder.CreateCylinder(
    "tree-trunk-base",
    { diameter: 0.55, height: 2.4, tessellation: 6 },
    scene,
  );
  trunkBase.material = createMaterial(scene, "island-trunk", 0.36, 0.25, 0.14);
  const canopyBase = MeshBuilder.CreateCylinder(
    "tree-canopy-base",
    { diameterTop: 0.25, diameterBottom: 3.9, height: 6.2, tessellation: 8 },
    scene,
  );
  canopyBase.material = createMaterial(scene, "island-foliage", 0.15, 0.4, 0.17);

  const TREE_ATTEMPTS = 1600;
  let placed = 0;
  for (let i = 0; i < TREE_ATTEMPTS && placed < 700; i++) {
    const x = (rng() * 2 - 1) * 1030;
    const z = (rng() * 2 - 1) * 1030;
    const h = heightAt(x, z);
    if (h < 2.4 || h > 58) continue; // beaches / high rock stay bare
    if (airportBoxDistance(x, z) < 46) continue; // keep the airfield clear
    if (Math.hypot(x - VILLAGE.x, z - VILLAGE.z) < VILLAGE.r + 12) continue;
    const slope = Math.abs(heightAt(x + 3, z) - h) + Math.abs(heightAt(x, z + 3) - h);
    if (slope > 2.6) continue;
    const s = 0.85 + rng() * 0.9;
    const sy = s * (0.9 + rng() * 0.35);
    const yaw = rng() * Math.PI * 2;
    const sink = 0.25;
    const trunk = trunkBase.createInstance(`tree-trunk-${placed}`);
    trunk.position.set(x, h - sink + (2.4 * sy) / 2, z);
    trunk.rotation.y = yaw;
    trunk.scaling.set(s, sy, s);
    const canopy = canopyBase.createInstance(`tree-canopy-${placed}`);
    canopy.position.set(x, h - sink + 2.4 * sy + (6.2 * sy) / 2 - 1.1 * sy, z);
    canopy.rotation.y = yaw;
    canopy.scaling.set(s, sy, s);
    placed++;
  }
  trunkBase.isVisible = false;
  canopyBase.isVisible = false;

  // ---------- Village (on the flattened pad) ----------
  const wallMats = [
    createMaterial(scene, "house-wall-a", 0.88, 0.83, 0.72),
    createMaterial(scene, "house-wall-b", 0.75, 0.82, 0.85),
    createMaterial(scene, "house-wall-c", 0.9, 0.76, 0.62),
  ];
  const roofMat = createMaterial(scene, "house-roof", 0.62, 0.3, 0.18);
  const houseSpots: Array<[number, number, number]> = [
    [-26, -14, 0.4], [4, -26, -0.3], [28, -8, 0.9], [-12, 16, 0.1], [18, 22, -0.6], [-34, 26, 0.7],
  ];
  houseSpots.forEach(([dx, dz, rot], i) => {
    const w = 7 + rng() * 3;
    const d = 6 + rng() * 2.5;
    const hgt = 3.4 + rng() * 1.2;
    const house = MeshBuilder.CreateBox(
      `house-${i}`,
      { width: w, height: hgt, depth: d },
      scene,
    );
    house.position = new Vector3(VILLAGE.x + dx, VILLAGE.h + hgt / 2 - 0.15, VILLAGE.z + dz);
    house.rotation.y = rot;
    house.material = wallMats[i % wallMats.length];
    house.receiveShadows = true;
    const roof = MeshBuilder.CreateCylinder(
      `house-roof-${i}`,
      { diameter: 0.1, height: Math.max(w, d) * 0.72, tessellation: 4 },
      scene,
    );
    // A 4-sided cone reads as a pyramid roof; squash it to the footprint
    roof.scaling = new Vector3(w / (Math.max(w, d) * 0.72) * 1.35, 1, d / (Math.max(w, d) * 0.72) * 1.35);
    roof.position = new Vector3(VILLAGE.x + dx, VILLAGE.h + hgt + 1.1, VILLAGE.z + dz);
    roof.rotation.y = rot + Math.PI / 4;
    roof.material = roofMat;
    roof.receiveShadows = true;
  });

  // ---------- Lighthouse (east headland, h ~2.6 m, gentle slope) ----------
  {
    const lx = 1010;
    const lz = -60;
    const baseY = heightAt(lx, lz);
    const white = createMaterial(scene, "lighthouse-white", 0.92, 0.92, 0.9);
    const red = createMaterial(scene, "lighthouse-red", 0.75, 0.2, 0.16);
    const shaft = MeshBuilder.CreateCylinder(
      "lighthouse",
      { diameterTop: 2.6, diameterBottom: 3.6, height: 15, tessellation: 12 },
      scene,
    );
    shaft.position = new Vector3(lx, baseY + 6.2, lz);
    shaft.material = white;
    const band = MeshBuilder.CreateCylinder(
      "lighthouse-band",
      { diameterTop: 3.05, diameterBottom: 3.3, height: 3.4, tessellation: 12 },
      scene,
    );
    band.position = new Vector3(lx, baseY + 7.4, lz);
    band.material = red;
    const lamp = MeshBuilder.CreateSphere("lighthouse-lamp", { diameter: 2.2, segments: 10 }, scene);
    lamp.position = new Vector3(lx, baseY + 14.8, lz);
    lamp.material = createMaterial(scene, "lighthouse-lamp", 1, 0.85, 0.4, {
      emissive: [0.9, 0.65, 0.2],
    });
  }

  return { terrain };
}
