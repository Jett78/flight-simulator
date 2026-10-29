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

const TERRAIN_SIZE = 4200;
const TERRAIN_SUBDIVISIONS = 250;

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
// Phase 12: positions/radii scaled x1.5 with the bigger island
// (heights unchanged); the near hills use ~x1.3 so they stay
// prominent from the runway.
const PEAKS: Peak[] = [
  { x: 930, z: -645, h: 165, r: 495 },
  { x: -1020, z: -390, h: 140, r: 450 },
  { x: -645, z: 855, h: 120, r: 420 },
  { x: 810, z: 960, h: 105, r: 390 },
  { x: -540, z: -1350, h: 150, r: 510 },
  // Scenery pass (0.10.2): two more backdrop peaks near the island
  // rim — far west and far north — kept well clear of the airport,
  // the departure corridor and the checkpoint route.
  { x: -1470, z: -60, h: 88, r: 450 },
  { x: 270, z: -1620, h: 92, r: 450 },
  // Near hills (live-check fix, 0.11.0): the big peaks are real
  // but read as a flat horizon strip from the runway. These lower,
  // closer hills east/west of the field are what a player standing
  // on the runway actually SEES as hills. All are clear of the
  // approach corridor and the checkpoint discs (verified by the
  // M8 clearance test).
  { x: 810, z: 340, h: 40, r: 270 },
  { x: -700, z: 160, h: 36, r: 260 },
  { x: 950, z: 520, h: 36, r: 260 },
];

/** Village pad centre (south-east shore) and its flattened height. */
export const VILLAGE = { x: 520, z: 1080, r: 80, h: 3.4 };

/** Signed distance outside the airport rectangle (0 when inside). */
function airportBoxDistance(x: number, z: number): number {
  const dx = Math.max(Math.abs(x) - 175, 0);
  const dz = Math.max(Math.abs(z) - 225, 0);
  return Math.hypot(dx, dz);
}

/** Terrain height in metres at world (x, z). Pure and deterministic. */
export function heightAt(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const angle = Math.atan2(z, x);
  const coastR = 1620 + 90 * Math.sin(angle * 3 + 1.3) + 45 * Math.sin(angle * 7 - 0.5);
  const coastT = clamp01((coastR - r) / 330); // 1 inland -> 0 offshore

  // Rolling hills, growing with distance from the airport pad.
  // 0.10.2 scenery pass: stronger, closer hills (they used to start
  // ~520 m out and top out around ±28 m, so the island read flat) —
  // now they begin ~430 m out with a broad swell underneath.
  const dAirport = airportBoxDistance(x, z);
  const hillGrow = smoothstep(dAirport / 340);
  const hills =
    (22 * Math.sin(x * 0.011 + 1.7) * Math.cos(z * 0.009 - 0.6) +
      14 * Math.sin(x * 0.023 - 0.4) * Math.sin(z * 0.019 + 1.2) +
      7 * Math.sin(x * 0.047) * Math.cos(z * 0.041) +
      10 * Math.sin(x * 0.004 + 0.7) * Math.cos(z * 0.0035 - 1.1)) *
    hillGrow;

  let mountains = 0;
  for (const p of PEAKS) {
    const d2 = (x - p.x) * (x - p.x) + (z - p.z) * (z - p.z);
    mountains += p.h * Math.exp(-d2 / (p.r * p.r));
  }

  // Approach/departure corridor: keep the ±Z centreline (|x| < ~120,
  // ramping to full relief by |x| = 260) gentle, so the stronger
  // 0.10.2 hills never rise into the takeoff or landing path. The
  // ground suite's full circuit caught exactly that: a banked final
  // met a new bump south of the field and wing-struck.
  const corridor = smoothstep((Math.abs(x) - 120) / 140);
  const shaped = (hills + mountains) * corridor;
  const hillsShaped = shaped; // combined relief, corridor-shaped

  let landH = Math.max(0.5, 1.7 + hillsShaped);
  // Village pad: flatten to a constant height near the shore
  const dVillage = Math.hypot(x - VILLAGE.x, z - VILLAGE.z);
  const villageWeight = 1 - smoothstep((dVillage - VILLAGE.r) / 80);
  landH = landH * (1 - villageWeight) + VILLAGE.h * villageWeight;

  // Blend land into seabed across the coastline
  let h = -7 + (landH + 7) * smoothstep(coastT);

  // Airport pad: perfectly flat y=0 (the airport geometry assumes it)
  const flatWeight = 1 - smoothstep(dAirport / 220);
  h *= 1 - flatWeight;
  return h;
}

/**
 * Height of the RENDERED terrain surface at (x, z): bilinear
 * interpolation of `heightAt` over the terrain mesh's vertex grid.
 *
 * The mesh only has vertices every TERRAIN_SIZE/SUBDIVISIONS metres,
 * so its surface is a faceted approximation of the analytic
 * heightfield — on hill slopes the two can differ by a metre or
 * more. Anything that must SIT on the visible ground (trees, the
 * physics ground sampler) has to use this function, not `heightAt`,
 * or it floats above / sinks into the mesh. (The floating trees
 * Jeet reported in 0.10.2 were placed with the analytic height.)
 */
export function terrainMeshHeightAt(x: number, z: number): number {
  const step = TERRAIN_SIZE / TERRAIN_SUBDIVISIONS;
  const half = TERRAIN_SIZE / 2;
  if (x < -half || x > half || z < -half || z > half) return heightAt(x, z);
  // Match CreateGround's exact vertex layout (Babylon
  // groundBuilder): vertex (row, col) sits at x = -half + col*step,
  // z = +half - row*step, and each quad is split along the diagonal
  // from its south-east to its north-west corner. Interpolating the
  // correct triangle makes this the rendered surface EXACTLY (the
  // earlier bilinear version could still sit ~0.5 m off a facet on
  // curved slopes).
  const i = Math.min(Math.floor((x + half) / step), TERRAIN_SUBDIVISIONS - 1);
  const j = Math.min(Math.floor((half - z) / step), TERRAIN_SUBDIVISIONS - 1);
  const x0 = -half + i * step;
  const zHigh = half - j * step;
  const zLow = zHigh - step;
  const fx = (x - x0) / step;
  const fz = (z - zLow) / step;
  const hSW = heightAt(x0, zLow);
  const hSE = heightAt(x0 + step, zLow);
  const hNW = heightAt(x0, zHigh);
  if (fx + fz <= 1) {
    // South-west triangle (SW, SE, NW)
    return hSW * (1 - fx - fz) + hSE * fx + hNW * fz;
  }
  // North-east triangle (SE, NE, NW)
  const hNE = heightAt(x0 + step, zHigh);
  return hNE * (fx + fz - 1) + hSE * (1 - fz) + hNW * (1 - fx);
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
    { diameter: 12600, segments: 24 },
    scene,
  );
  {
    const positions = sky.getVerticesData(VertexBuffer.PositionKind);
    const colors: number[] = [];
    if (positions) {
      const c: number[] = [];
      for (let i = 0; i < positions.length; i += 3) {
        const yNorm = positions[i + 1] / 6300; // -1..1
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
    // NOTE: do NOT set disableLighting here. In Babylon.js that flag
    // means "receives no light at all" — a StandardMaterial then
    // renders BLACK (its albedo, vertex colours included, is
    // multiplied by zero light), which is exactly the solid-black
    // sky two live browser checks reported in Phase 5/6. The dome
    // stays lit by the scene's hemisphere + sun lights, which tint
    // the vertex-colour gradient naturally. The small emissive lift
    // keeps the faces turned away from the sun from going too dark.
    skyMat.emissiveColor = new Color3(0.1, 0.13, 0.18);
    skyMat.fogEnabled = false;
    skyMat.backFaceCulling = false; // we view the dome from inside
    sky.material = skyMat;
    sky.useVertexColors = true;
    sky.isPickable = false;
  }

  // ---------- Ocean ----------
  const ocean = MeshBuilder.CreateGround(
    "ocean",
    { width: 14000, height: 14000, subdivisions: 1 },
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
      // The heightfield displacement below rewrites the position
      // buffer after creation — the mesh must be updatable or the
      // GPU keeps the flat grid (the CPU-side data still updates,
      // which is why headless checks could not see this).
      updatable: true,
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
      // Spatially coherent tint patches (Phase 8): smooth low-
      // frequency variation reads as meadow/forest patchiness from
      // the air, where per-vertex random tint just looked like grain.
      const tint =
        0.96 +
        0.045 * Math.sin(positions[i] * 0.021 + positions[i + 2] * 0.013) +
        0.035 * Math.sin(positions[i] * 0.113 - positions[i + 2] * 0.071);
      terrainColor(h, slope, tint, c);
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
  canopyBase.material = createMaterial(scene, "island-foliage", 0.13, 0.38, 0.16);
  // Phase 8: a lighter second foliage tone (trees pick one at
  // random) and a smaller upper cone tier for a two-tier pine
  // silhouette. Still fully instanced: 4 draw calls for all trees.
  const canopyBaseB = MeshBuilder.CreateCylinder(
    "tree-canopy-base-b",
    { diameterTop: 0.25, diameterBottom: 3.9, height: 6.2, tessellation: 8 },
    scene,
  );
  canopyBaseB.material = createMaterial(scene, "island-foliage-b", 0.31, 0.51, 0.21);
  const canopyTopBase = MeshBuilder.CreateCylinder(
    "tree-canopy-top-base",
    { diameterTop: 0.1, diameterBottom: 2.7, height: 4.4, tessellation: 8 },
    scene,
  );
  canopyTopBase.material = createMaterial(scene, "island-foliage-top", 0.2, 0.45, 0.19);

  const TREE_ATTEMPTS = 3400;
  let placed = 0;
  for (let i = 0; i < TREE_ATTEMPTS && placed < 1150; i++) {
    const x = (rng() * 2 - 1) * 1560;
    const z = (rng() * 2 - 1) * 1560;
    // Sit trees on the RENDERED surface (see terrainMeshHeightAt) —
    // the analytic height left them floating on slopes.
    const h = terrainMeshHeightAt(x, z);
    if (h < 2.4 || h > 88) continue; // beaches / bare rock stay bare; hilltops DO get trees (Jeet: "above them should be trees")
    if (airportBoxDistance(x, z) < 46) continue; // keep the airfield clear
    if (Math.hypot(x - VILLAGE.x, z - VILLAGE.z) < VILLAGE.r + 12) continue;
    const slope =
      Math.abs(terrainMeshHeightAt(x + 3, z) - h) +
      Math.abs(terrainMeshHeightAt(x, z + 3) - h);
    if (slope > 2.1) continue; // a vertical trunk can't hug steep faces
    const s = 0.85 + rng() * 0.9;
    const sy = s * (0.9 + rng() * 0.35);
    const yaw = rng() * Math.PI * 2;
    const sink = 0.5;
    const trunk = trunkBase.createInstance(`tree-trunk-${placed}`);
    trunk.position.set(x, h - sink + (2.4 * sy) / 2, z);
    trunk.rotation.y = yaw;
    trunk.scaling.set(s, sy, s);
    const canopySrc = rng() < 0.5 ? canopyBase : canopyBaseB;
    const canopy = canopySrc.createInstance(`tree-canopy-${placed}`);
    canopy.position.set(x, h - sink + 2.4 * sy + (6.2 * sy) / 2 - 1.1 * sy, z);
    canopy.rotation.y = yaw;
    canopy.scaling.set(s, sy, s);
    const top = canopyTopBase.createInstance(`tree-canopy-top-${placed}`);
    top.position.set(x, h - sink + 7.4 * sy, z);
    top.rotation.y = yaw;
    top.scaling.set(s, sy, s);
    placed++;
  }
  trunkBase.isVisible = false;
  canopyBase.isVisible = false;
  canopyBaseB.isVisible = false;
  canopyTopBase.isVisible = false;

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
    const lx = 1560;
    const lz = -90;
    const baseY = terrainMeshHeightAt(lx, lz);
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
