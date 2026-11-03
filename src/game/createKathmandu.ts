import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Scene } from "@babylonjs/core/scene";
import { createMaterial } from "./materials";
import type { Obstacle } from "./obstacles";

/**
 * Kathmandu city (Phase 25) — Jeet: "map the city of Kathmandu
 * and add that city too here".
 *
 * A stylised Kathmandu Valley floor carved into the hills WEST of
 * the airport, the same side as the real city sits from Tribhuvan
 * airport. `KATHMANDU` is the flattened pad: createIsland's
 * heightAt blends the terrain to `h` inside `r` (with a ~110 m
 * valley-wall blend outside it), so every building sits on flat
 * ground by construction and the hills rise around it like the
 * valley rim.
 *
 * Contents:
 * - A road grid + an urban ground disc over the pad.
 * - Mid-rise city buildings (brick / cream / concrete valley
 *   palette), merged by colour into a handful of draw calls, each
 *   one a registered solid obstacle.
 *
 * Phase 26 (Jeet: "remove that greenery, add buildings, make it
 * like a city"): the pad grew 150 -> 235 m radius and the blocks
 * now fill it edge to edge (~110 buildings), the urban ground
 * tint reaches past the pad, and trees are excluded well beyond
 * it — no grass or trees inside the city any more, buildings and
 * roads all the way out.
 * - Durbar Square: three tiered pagoda temples on a stone plaza.
 * - The Dharahara tower (white, balconied, ~48 m) beside the plaza.
 * - Swayambhunath: white dome + gold spire on its mound at the
 *   city's western edge, where the valley wall starts to rise.
 * - The Ghanta Ghar clock tower.
 * - A soft gold beacon pillar over the centre, checkpoint-style,
 *   so the city is findable from the air; the mission minimap
 *   carries a KTM marker too.
 */

export const KATHMANDU = { x: -640, z: -120, r: 235, h: 34 };

/** Deterministic seeded RNG so the city is identical every load. */
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

export interface KathmanduResult {
  obstacles: Obstacle[];
}

export function createKathmandu(scene: Scene): KathmanduResult {
  const rng = mulberry32(20261103);
  const obstacles: Obstacle[] = [];
  const { x: cx, z: cz, h } = KATHMANDU;
  const box = (
    name: string,
    w: number,
    hgt: number,
    d: number,
    x: number,
    y: number,
    z: number,
  ): Mesh => {
    const m = MeshBuilder.CreateBox(name, { width: w, height: hgt, depth: d }, scene);
    m.position = new Vector3(x, y, z);
    return m;
  };

  // ---------- Urban ground disc + road grid ----------
  const floor = MeshBuilder.CreateDisc(
    "kathmandu-floor",
    { radius: KATHMANDU.r + 4, tessellation: 48 },
    scene,
  );
  floor.rotation.x = -Math.PI / 2; // disc normal +Z -> +Y (faces up)
  floor.position = new Vector3(cx, h + 0.06, cz);
  floor.material = createMaterial(scene, "kathmandu-ground", 0.52, 0.49, 0.44);
  floor.receiveShadows = true;
  floor.isPickable = false;

  const roadMat = createMaterial(scene, "kathmandu-road", 0.16, 0.16, 0.17, {
    specular: 0.05,
  });
  const roadMeshes: Mesh[] = [];
  const STREET_OFFS = [-198, -132, -66, 0, 66, 132, 198];
  STREET_OFFS.forEach((o, i) => {
    // Clip each street to the city disc (chord length at this
    // offset) so road ends never leave the flat pad.
    const chord = 2 * Math.sqrt(Math.max(0, 225 * 225 - o * o));
    roadMeshes.push(box(`ktm-road-ns-${i}`, 10, 0.22, chord, cx + o, h + 0.17, cz));
    roadMeshes.push(box(`ktm-road-ew-${i}`, chord, 0.22, 10, cx, h + 0.17, cz + o));
  });
  const roads = Mesh.MergeMeshes(roadMeshes, true);
  if (roads) {
    roads.name = "kathmandu-roads";
    roads.material = roadMat;
    roads.receiveShadows = true;
    roads.isPickable = false;
  }

  // ---------- City buildings (merged per palette colour) ----------
  const PALETTE: Array<[string, number, number, number]> = [
    ["ktm-brick", 0.62, 0.34, 0.24],
    ["ktm-brick-dark", 0.52, 0.29, 0.21],
    ["ktm-cream", 0.87, 0.8, 0.68],
    ["ktm-white", 0.88, 0.87, 0.83],
    ["ktm-concrete", 0.62, 0.62, 0.6],
    ["ktm-ochre", 0.78, 0.58, 0.32],
    ["ktm-rose", 0.8, 0.6, 0.55],
  ];
  const byColor = new Map<number, Mesh[]>();
  const roofMeshes: Mesh[] = [];
  // Blocks sit between the streets; each block holds a 2x2 of lots.
  const BLOCK_OFFS = [-165, -99, -33, 33, 99, 165];
  const PLAZA_BLOCK = { bx: 33, bz: 33 }; // Durbar Square (below)
  const STUPA = { dx: -148, dz: -148 };
  let bIdx = 0;
  for (const bx of BLOCK_OFFS) {
    for (const bz of BLOCK_OFFS) {
      if (bx === PLAZA_BLOCK.bx && bz === PLAZA_BLOCK.bz) continue;
      for (const lx of [-14, 14]) {
        for (const lz of [-14, 14]) {
          const dx = bx + lx;
          const dz = bz + lz;
          if (Math.hypot(dx, dz) > 208) continue; // keep lots inside the city disc
          if (Math.hypot(dx - STUPA.dx, dz - STUPA.dz) < 42) continue; // stupa mound
          if (rng() < 0.06) continue; // rare courtyard / open lot
          const w = 17 + rng() * 7;
          const d = 17 + rng() * 7;
          const centreBoost = Math.max(0, (200 - Math.hypot(dx, dz)) / 200) * 18;
          const hgt = 11 + rng() * 14 + centreBoost;
          const x = cx + dx;
          const z = cz + dz;
          const b = box(`ktm-b-${bIdx}`, w, hgt, d, x, h + hgt / 2, z);
          const ci = Math.floor(rng() * PALETTE.length);
          const list = byColor.get(ci) ?? [];
          list.push(b);
          byColor.set(ci, list);
          roofMeshes.push(box(`ktm-r-${bIdx}`, w + 1.2, 1.1, d + 1.2, x, h + hgt + 0.55, z));
          if (rng() < 0.35) {
            // Rooftop water tank, on most Kathmandu rooftops.
            const tank = MeshBuilder.CreateCylinder(
              `ktm-t-${bIdx}`,
              { diameter: 3.2, height: 2.2, tessellation: 10 },
              scene,
            );
            tank.position = new Vector3(
              x + (rng() - 0.5) * (w - 6),
              h + hgt + 2.2,
              z + (rng() - 0.5) * (d - 6),
            );
            roofMeshes.push(tank);
          }
          obstacles.push({
            kind: "box",
            name: `city-building-${bIdx}`,
            minX: x - w / 2,
            maxX: x + w / 2,
            minZ: z - d / 2,
            maxZ: z + d / 2,
            baseY: h,
            topY: h + hgt + 1.1,
          });
          bIdx++;
        }
      }
    }
  }
  PALETTE.forEach(([name, r, g, bl], ci) => {
    const list = byColor.get(ci);
    if (!list || list.length === 0) return;
    const merged = Mesh.MergeMeshes(list, true);
    if (merged) {
      merged.name = `kathmandu-buildings-${ci}`;
      merged.material = createMaterial(scene, name, r, g, bl);
      merged.receiveShadows = true;
    }
  });
  const roofs = Mesh.MergeMeshes(roofMeshes, true);
  if (roofs) {
    roofs.name = "kathmandu-roofs";
    roofs.material = createMaterial(scene, "ktm-roof", 0.32, 0.3, 0.32);
    roofs.receiveShadows = true;
  }

  // ---------- Durbar Square: plaza + tiered pagoda temples ----------
  const plazaX = cx + PLAZA_BLOCK.bx;
  const plazaZ = cz + PLAZA_BLOCK.bz;
  const plaza = box("durbar-plaza", 54, 0.3, 54, plazaX, h + 0.21, plazaZ);
  plaza.material = createMaterial(scene, "durbar-stone", 0.58, 0.53, 0.47);
  plaza.receiveShadows = true;
  const plazaBaseY = h + 0.36;
  const brickMat = createMaterial(scene, "durbar-brick", 0.5, 0.26, 0.18);
  const pagodaRoofMat = createMaterial(scene, "durbar-roof", 0.42, 0.2, 0.13);
  const stoneMat = createMaterial(scene, "durbar-plinth", 0.55, 0.52, 0.48);
  const temples: Array<[number, number, number]> = [
    [plazaX - 15, plazaZ - 14, 1.15],
    [plazaX + 8, plazaZ - 6, 1.5],
    [plazaX - 8, plazaZ + 12, 0.9],
  ];
  temples.forEach(([tx, tz, s], i) => {
    const plinth = box(`durbar-temple-${i}-plinth`, 11 * s, 1.3, 11 * s, tx, plazaBaseY + 0.65, tz);
    plinth.material = stoneMat;
    const towerH = 5.2 * s;
    const tower = box(
      `durbar-temple-${i}-tower`,
      6 * s,
      towerH,
      6 * s,
      tx,
      plazaBaseY + 1.3 + towerH / 2,
      tz,
    );
    tower.material = brickMat;
    let roofY = plazaBaseY + 1.3 + towerH;
    let roofW = 10.5 * s;
    for (let tier = 0; tier < 3; tier++) {
      const roof = MeshBuilder.CreateCylinder(
        `durbar-temple-${i}-roof-${tier}`,
        { diameterTop: 0.4, diameterBottom: roofW * 1.42, height: 2.1 * s, tessellation: 4 },
        scene,
      );
      roof.position = new Vector3(tx, roofY + 1.05 * s, tz);
      roof.rotation.y = Math.PI / 4;
      roof.material = pagodaRoofMat;
      roofY += 1.55 * s;
      roofW *= 0.68;
    }
    obstacles.push({
      kind: "box",
      name: `durbar-temple-${i}`,
      minX: tx - 5.5 * s,
      maxX: tx + 5.5 * s,
      minZ: tz - 5.5 * s,
      maxZ: tz + 5.5 * s,
      baseY: plazaBaseY,
      topY: roofY + 1.1 * s,
    });
  });

  // ---------- Dharahara tower (SE corner of the plaza block) ----------
  {
    const dx = cx + 60;
    const dz = cz + 58;
    const white = createMaterial(scene, "dharahara-white", 0.93, 0.91, 0.86);
    const trim = createMaterial(scene, "dharahara-trim", 0.74, 0.71, 0.65);
    const shaft = MeshBuilder.CreateCylinder(
      "dharahara",
      { diameterTop: 4.2, diameterBottom: 6.4, height: 40, tessellation: 14 },
      scene,
    );
    shaft.position = new Vector3(dx, plazaBaseY + 20, dz);
    shaft.material = white;
    shaft.receiveShadows = true;
    [14, 26, 36.5].forEach((y, i) => {
      const balc = MeshBuilder.CreateCylinder(
        `dharahara-balcony-${i}`,
        { diameter: 7.4 - i * 0.9, height: 1.2, tessellation: 14 },
        scene,
      );
      balc.position = new Vector3(dx, plazaBaseY + y, dz);
      balc.material = trim;
    });
    const cap = MeshBuilder.CreateCylinder(
      "dharahara-cap",
      { diameterTop: 0.3, diameterBottom: 4.6, height: 6, tessellation: 14 },
      scene,
    );
    cap.position = new Vector3(dx, plazaBaseY + 43, dz);
    cap.material = trim;
    const finial = MeshBuilder.CreateSphere("dharahara-finial", { diameter: 1.1, segments: 8 }, scene);
    finial.position = new Vector3(dx, plazaBaseY + 46.6, dz);
    finial.material = createMaterial(scene, "dharahara-gold", 0.9, 0.68, 0.2, {
      emissive: [0.35, 0.25, 0.05],
    });
    obstacles.push({
      kind: "cylinder",
      name: "dharahara",
      x: dx,
      z: dz,
      radius: 4.6,
      baseY: h,
      topY: plazaBaseY + 47,
    });
  }

  // ---------- Swayambhunath stupa (western mound) ----------
  {
    const sx = cx + STUPA.dx;
    const sz = cz + STUPA.dz;
    const mound = MeshBuilder.CreateCylinder(
      "swayambhu-mound",
      { diameterTop: 36, diameterBottom: 46, height: 7, tessellation: 20 },
      scene,
    );
    mound.position = new Vector3(sx, h + 3.5, sz);
    mound.material = createMaterial(scene, "swayambhu-mound", 0.52, 0.48, 0.42);
    mound.receiveShadows = true;
    const whitewash = createMaterial(scene, "swayambhu-white", 0.9, 0.88, 0.82);
    let by = h + 7;
    [21, 16.5, 12].forEach((w, i) => {
      const base = box(`swayambhu-base-${i}`, w, 1.6, w, sx, by + 0.8, sz);
      base.material = whitewash;
      by += 1.6;
    });
    const dome = MeshBuilder.CreateSphere(
      "swayambhu-dome",
      { diameter: 10.5, segments: 12 },
      scene,
    );
    dome.scaling = new Vector3(1, 0.82, 1);
    dome.position = new Vector3(sx, by + 3.2, sz);
    dome.material = whitewash;
    const gold = createMaterial(scene, "swayambhu-gold", 0.85, 0.62, 0.18, {
      emissive: [0.3, 0.2, 0.04],
    });
    const harmika = box("swayambhu-harmika", 2.8, 1.8, 2.8, sx, by + 8.2, sz);
    harmika.material = gold;
    const spire = MeshBuilder.CreateCylinder(
      "swayambhu-spire",
      { diameterTop: 0.2, diameterBottom: 3, height: 5.5, tessellation: 10 },
      scene,
    );
    spire.position = new Vector3(sx, by + 11.8, sz);
    spire.material = gold;
    obstacles.push({
      kind: "box",
      name: "swayambhu-stupa",
      minX: sx - 13,
      maxX: sx + 13,
      minZ: sz - 13,
      maxZ: sz + 13,
      baseY: h,
      topY: by + 14.6,
    });
  }

  // ---------- Ghanta Ghar clock tower ----------
  {
    const gx = cx - 30;
    const gz = cz + 96;
    const tower = box("clock-tower", 6, 20, 6, gx, h + 10, gz);
    tower.material = createMaterial(scene, "ghantaghar-cream", 0.86, 0.78, 0.62);
    tower.receiveShadows = true;
    const top = MeshBuilder.CreateCylinder(
      "clock-tower-top",
      { diameterTop: 0.3, diameterBottom: 7.4, height: 4.5, tessellation: 4 },
      scene,
    );
    top.position = new Vector3(gx, h + 22.2, gz);
    top.rotation.y = Math.PI / 4;
    top.material = createMaterial(scene, "ghantaghar-roof", 0.4, 0.24, 0.16);
    obstacles.push({
      kind: "box",
      name: "clock-tower",
      minX: gx - 3,
      maxX: gx + 3,
      minZ: gz - 3,
      maxZ: gz + 3,
      baseY: h,
      topY: h + 24.5,
    });
  }

  // ---------- Findability beacon (visual only, like the checkpoints') ----------
  const beacon = MeshBuilder.CreateCylinder(
    "kathmandu-beacon",
    { height: 230, diameterTop: 6, diameterBottom: 6, tessellation: 16 },
    scene,
  );
  beacon.position = new Vector3(cx, h + 115, cz);
  beacon.material = createMaterial(scene, "kathmandu-beacon", 1, 0.68, 0.12, {
    alpha: 0.13,
    emissive: [0.2, 0.13, 0.02],
    specular: 0,
  });
  beacon.isPickable = false;

  return { obstacles };
}
