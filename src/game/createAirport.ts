import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Scene } from "@babylonjs/core/scene";
import { terrainMeshHeightAt } from "./createIsland";
import { createMaterial } from "./materials";

export interface AirportResult {
  /** Meshes that should cast shadows (buildings, tower, trees). */
  shadowCasters: Mesh[];
  /** Surfaces that should receive shadows (ground, runway, apron...). */
  shadowReceivers: Mesh[];
}

/**
 * Stylised airport environment: grass, runway with markings,
 * taxiway + apron, hangars, a terminal, an office block and a tower.
 * Runway runs along Z, centred on the origin.
 */
export function createAirport(scene: Scene): AirportResult {
  const casters: Mesh[] = [];
  const receivers: Mesh[] = [];

  const asphalt = createMaterial(scene, "asphalt", 0.13, 0.13, 0.15);
  const concrete = createMaterial(scene, "concrete", 0.62, 0.63, 0.65);
  const markingWhite = createMaterial(scene, "marking-white", 0.95, 0.95, 0.95, {
    emissive: [0.25, 0.25, 0.25],
  });
  const markingYellow = createMaterial(scene, "marking-yellow", 0.95, 0.75, 0.1, {
    emissive: [0.2, 0.15, 0.02],
  });
  const wallLight = createMaterial(scene, "wall-light", 0.82, 0.8, 0.76);
  const roofDark = createMaterial(scene, "roof-dark", 0.16, 0.2, 0.28);
  const roofHangar = createMaterial(scene, "roof-hangar", 0.45, 0.48, 0.52);
  const doorDark = createMaterial(scene, "door-dark", 0.1, 0.12, 0.16);
  const glass = createMaterial(scene, "glass", 0.1, 0.22, 0.34, { specular: 0.8 });
  // Phase 8: window-facade texture for the terminal / office /
  // tower shaft, drawn once on a small canvas (no external assets):
  // pale concrete with a grid of dark windows and a ground floor.
  const facadeMat = (() => {
    try {
      return buildFacadeMaterial();
    } catch {
      // No canvas available (e.g. the headless NullEngine tests):
      // fall back to a plain wall material — looks are optional,
      // construction must never depend on them.
      return createMaterial(scene, "wall-facade-fallback", 0.72, 0.75, 0.79);
    }
  })();
  function buildFacadeMaterial() {
    const tex = new DynamicTexture("facade-texture", { width: 512, height: 256 }, scene, true);
    const ctx = tex.getContext();
    ctx.fillStyle = "#b7c0c9";
    ctx.fillRect(0, 0, 512, 256);
    ctx.fillStyle = "#9aa5b1";
    ctx.fillRect(0, 208, 512, 48); // ground floor band
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 10; col++) {
        const shade = 38 + ((row * 7 + col * 13) % 18);
        ctx.fillStyle = `rgb(${shade}, ${shade + 18}, ${shade + 34})`;
        ctx.fillRect(18 + col * 49, 20 + row * 44, 32, 24);
      }
    }
    ctx.fillStyle = "#5a6673";
    ctx.fillRect(226, 196, 60, 60); // entrance
    tex.update();
    const mat = new StandardMaterial("wall-facade", scene);
    mat.diffuseTexture = tex;
    mat.specularColor = new Color3(0.12, 0.12, 0.12);
    return mat;
  }
  const trunkMat = createMaterial(scene, "trunk", 0.36, 0.25, 0.14);
  const foliageMat = createMaterial(scene, "foliage", 0.16, 0.42, 0.18);

  const box = (
    name: string,
    size: { width: number; height: number; depth: number },
    position: [number, number, number],
    material = concrete,
    opts?: { cast?: boolean; receive?: boolean },
  ): Mesh => {
    const mesh = MeshBuilder.CreateBox(name, size, scene);
    mesh.position = new Vector3(...position);
    mesh.material = material;
    mesh.receiveShadows = opts?.receive ?? true;
    if (opts?.cast) casters.push(mesh);
    if (mesh.receiveShadows) receivers.push(mesh);
    return mesh;
  };

  // ---------- Ground ----------
  // Phase 5: the island terrain (createIsland) provides the ground —
  // it is flattened to y=0 across the whole airport pad, so every
  // mesh here sits exactly as before. The old 900x900 grass plane
  // that used to live here is gone.

  // Slightly lighter mowed strip around the runway for definition
  box(
    "mowed-strip",
    { width: 52, height: 0.04, depth: 340 },
    [0, 0.02, 0],
    createMaterial(scene, "grass-light", 0.4, 0.64, 0.33),
    { receive: true },
  );

  // ---------- Runway (along Z) ----------
  box("runway", { width: 18, height: 0.16, depth: 300 }, [0, 0.08, 0], asphalt);

  // Edge lines
  for (const side of [-1, 1]) {
    box(
      `runway-edge-${side}`,
      { width: 0.5, height: 0.18, depth: 296 },
      [side * 8.2, 0.09, 0],
      markingWhite,
    );
  }

  // Centreline dashes
  for (let z = -136; z <= 136; z += 16) {
    box(
      `centreline-${z}`,
      { width: 0.7, height: 0.18, depth: 8 },
      [0, 0.09, z],
      markingWhite,
    );
  }

  // Threshold bars at both ends (piano keys)
  for (const end of [-1, 1]) {
    for (let i = -3; i <= 3; i++) {
      if (i === 0) continue;
      box(
        `threshold-${end}-${i}`,
        { width: 1.1, height: 0.18, depth: 10 },
        [i * 2.2, 0.09, end * 142],
        markingWhite,
      );
    }
  }

  // ---------- Taxiway + apron (west side) ----------
  box("taxiway", { width: 48, height: 0.12, depth: 9 }, [-32, 0.06, 30], asphalt);
  // Taxiway centreline
  box(
    "taxiway-centreline",
    { width: 46, height: 0.14, depth: 0.5 },
    [-32, 0.07, 30],
    markingYellow,
  );
  box("apron", { width: 38, height: 0.12, depth: 46 }, [-70, 0.06, 30], concrete);

  // ---------- Hangars (west, off the apron) ----------
  const hangar = (name: string, x: number, z: number, w: number, d: number, h: number) => {
    box(name, { width: w, height: h, depth: d }, [x, h / 2, z], wallLight, { cast: true });
    // Flat overhanging roof slab — reads clearly as a hangar from the air
    box(`${name}-roof`, { width: w + 1.6, height: 0.6, depth: d + 1.6 }, [x, h + 0.3, z], roofHangar, {
      cast: true,
    });
    // Large front door facing the apron (+X side)
    box(
      `${name}-door`,
      { width: 0.3, height: h * 0.72, depth: d * 0.72 },
      [x + w / 2 + 0.05, h * 0.36, z],
      doorDark,
    );
  };
  hangar("hangar-a", -70, -22, 26, 20, 10);
  hangar("hangar-b", -70, -54, 22, 18, 8.5);

  // ---------- Terminal + office (east side) ----------
  box("terminal", { width: 32, height: 9, depth: 14 }, [36, 4.5, -26], facadeMat, { cast: true });
  box("terminal-roof", { width: 34, height: 0.7, depth: 16 }, [36, 9.35, -26], roofDark, { cast: true });
  // Terminal window band
  box("terminal-glass", { width: 32.3, height: 2.6, depth: 10 }, [36, 5.6, -26], glass);
  box("office", { width: 16, height: 6, depth: 11 }, [34, 3, 10], facadeMat, { cast: true });
  box("office-roof", { width: 17.5, height: 0.6, depth: 12.5 }, [34, 6.3, 10], roofDark, { cast: true });

  // ---------- Control tower (east, south of terminal) ----------
  box("tower-shaft", { width: 5.5, height: 21, depth: 5.5 }, [30, 10.5, -62], facadeMat, { cast: true });
  box("tower-cab", { width: 9, height: 3.6, depth: 9 }, [30, 22.8, -62], glass, { cast: true });
  box("tower-roof", { width: 10, height: 0.6, depth: 10 }, [30, 24.9, -62], roofDark, { cast: true });

  // ---------- Phase 12: a busier airport ----------
  // Third hangar (west, south of hangar B)
  hangar("hangar-c", -70, -88, 24, 20, 9.5);

  // Cargo terminal (east, south of the passenger terminal)
  box("cargo", { width: 20, height: 8, depth: 16 }, [64, 4, -30], facadeMat, { cast: true });
  box("cargo-roof", { width: 22, height: 0.7, depth: 18 }, [64, 8.35, -30], roofDark, { cast: true });
  box("cargo-glass", { width: 20.3, height: 2.2, depth: 11 }, [64, 5.2, -30], glass);
  // Freight containers stacked by the cargo apron
  const containerSpots: Array<[number, number, number, StandardMaterial]> = [
    [62, -52, 0, roofHangar],
    [62, -58.5, 0, wallLight],
    [69, -55, Math.PI / 2, roofHangar],
  ];
  containerSpots.forEach(([x, z, rot, mat], i) => {
    const c = box(`container-${i}`, { width: 6, height: 2.6, depth: 2.4 }, [x, 1.3, z], mat, { cast: true });
    c.rotation.y = rot;
  });

  // Terminal 2: a taller second block east of the office
  box("terminal-2", { width: 14, height: 13, depth: 12 }, [60, 6.5, 18], facadeMat, { cast: true });
  box("terminal-2-roof", { width: 16, height: 0.7, depth: 14 }, [60, 13.35, 18], roofDark, { cast: true });

  // Fire station (east, far south)
  box("fire-station", { width: 14, height: 5, depth: 10 }, [54, 2.5, -94], wallLight, { cast: true });
  box("fire-station-roof", { width: 15.5, height: 0.6, depth: 11.5 }, [54, 5.3, -94], roofDark, { cast: true });
  box("fire-station-door", { width: 0.3, height: 3.4, depth: 7 }, [46.9, 1.7, -94], doorDark);

  // Fuel depot (west of the hangars): three standing tanks + pump house
  const tankMat = roofHangar;
  [-28, -37, -46].forEach((z, i) => {
    const tank = MeshBuilder.CreateCylinder(
      `fuel-tank-${i}`,
      { diameter: 4.2, height: 5.5, tessellation: 14 },
      scene,
    );
    tank.position = new Vector3(-100, 2.75, z);
    tank.material = tankMat;
    tank.receiveShadows = true;
    casters.push(tank);
    receivers.push(tank);
  });
  box("fuel-pump-house", { width: 6, height: 3, depth: 5 }, [-100, 1.5, -18], wallLight, { cast: true });

  // Radar tower (far east): base, pole and a scanner bar
  box("radar-base", { width: 4.5, height: 1.6, depth: 4.5 }, [88, 0.8, -64], concrete, { cast: true });
  const radarPole = MeshBuilder.CreateCylinder(
    "radar-pole",
    { diameter: 1.4, height: 13, tessellation: 10 },
    scene,
  );
  radarPole.position = new Vector3(88, 7.3, -64);
  radarPole.material = wallLight;
  casters.push(radarPole);
  const radarBar = box("radar-bar", { width: 8, height: 0.9, depth: 1.8 }, [88, 14.2, -64], roofDark, { cast: true });
  radarBar.rotation.y = 0.6;

  // Windsock by the runway's south end (pole + orange cone)
  const sockPole = MeshBuilder.CreateCylinder(
    "windsock-pole",
    { diameter: 0.24, height: 6, tessellation: 8 },
    scene,
  );
  sockPole.position = new Vector3(30, 3, 118);
  sockPole.material = roofHangar;
  casters.push(sockPole);
  const sock = MeshBuilder.CreateCylinder(
    "windsock",
    { diameterTop: 0.25, diameterBottom: 0.9, height: 2.4, tessellation: 10 },
    scene,
  );
  sock.position = new Vector3(31.2, 5.6, 118);
  sock.rotation.z = -1.35;
  sock.material = createMaterial(scene, "windsock-orange", 0.92, 0.45, 0.1, { emissive: [0.25, 0.1, 0.01] });
  casters.push(sock);

  // Apron edge lights (small emissive blocks along the apron's east edge)
  for (let z = 10; z <= 52; z += 6) {
    box(`apron-light-${z}`, { width: 0.35, height: 0.35, depth: 0.35 }, [-50, 0.3, z], markingYellow);
  }

  // ---------- Simple trees for scale (cones + trunks) ----------
  const treeSpots: Array<[number, number]> = [
    [58, -70], [66, -38], [58, 28], [70, 52], [-102, 62], [-104, -6], [-100, -72], [52, 74],
    [92, -20], [96, 42], [-114, 28], [-116, -44], [86, 86], [-98, 88],
  ];
  treeSpots.forEach(([x, z], i) => {
    // Ground on the island surface: these trees predate the island
    // (Phase 1 flat ground at y=0) and their trunks ended up buried
    // under the terrain pad once the island arrived.
    const groundY = terrainMeshHeightAt(x, z) - 0.15;
    const trunk = MeshBuilder.CreateCylinder(
      `trunk-${i}`,
      { diameter: 0.7, height: 2.6, tessellation: 7 },
      scene,
    );
    trunk.position = new Vector3(x, groundY + 1.3, z);
    trunk.material = trunkMat;
    casters.push(trunk);

    const foliage = MeshBuilder.CreateCylinder(
      `foliage-${i}`,
      { diameterTop: 0.2, diameterBottom: 4.4, height: 6.5, tessellation: 9 },
      scene,
    );
    foliage.position = new Vector3(x, groundY + 5.6, z);
    foliage.material = foliageMat;
    casters.push(foliage);
  });

  return { shadowCasters: casters, shadowReceivers: receivers };
}
