import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { createMaterial } from "./materials";

/**
 * Placeholder airplane built only from Babylon.js primitives (Phase 2 model).
 *
 * Coordinate convention — shared with the chase camera:
 *   forward = -Z (nose), up = +Y, right wing = +X.
 * All meshes are children of a single root TransformNode, so moving or
 * rotating the root moves the whole aircraft. Local origin sits at the
 * fuselage centre; the wheels touch the ground at local y ≈ -2.25, so the
 * caller places the root at runway height + 2.25.
 */
export function createAirplane(scene: Scene): TransformNode {
  const root = new TransformNode("airplane", scene);

  const white = createMaterial(scene, "plane-white", 0.93, 0.94, 0.96, { specular: 0.35 });
  const belly = createMaterial(scene, "plane-belly", 0.78, 0.8, 0.84, { specular: 0.25 });
  const accent = createMaterial(scene, "plane-accent", 0.08, 0.35, 0.75, { specular: 0.3 });
  const orange = createMaterial(scene, "plane-orange", 0.95, 0.45, 0.08, { specular: 0.25 });
  const dark = createMaterial(scene, "plane-dark", 0.07, 0.1, 0.16, { specular: 0.6 });
  const metal = createMaterial(scene, "plane-metal", 0.55, 0.58, 0.62, { specular: 0.5 });
  const tyre = createMaterial(scene, "plane-tyre", 0.05, 0.05, 0.06, { specular: 0.05 });
  const intakeMat = createMaterial(scene, "plane-intake", 0.03, 0.03, 0.04, { specular: 0.1 });
  const navRed = createMaterial(scene, "nav-red", 0.6, 0.05, 0.05, {
    emissive: [0.9, 0.08, 0.08],
  });
  const navGreen = createMaterial(scene, "nav-green", 0.05, 0.6, 0.15, {
    emissive: [0.08, 0.9, 0.2],
  });
  const beaconMat = createMaterial(scene, "beacon", 0.7, 0.05, 0.05, {
    emissive: [1, 0.1, 0.1],
  });

  const add = (mesh: Mesh, position: [number, number, number]) => {
    mesh.position = new Vector3(...position);
    mesh.parent = root;
    mesh.receiveShadows = false;
    return mesh;
  };

  // ---------- Fuselage ----------
  // Main tube: z from -5.25 (front) to +5.25 (rear), radius 1.2
  const fuselage = MeshBuilder.CreateCylinder(
    "fuselage",
    { diameter: 2.4, height: 10.5, tessellation: 28 },
    scene,
  );
  fuselage.rotation.x = Math.PI / 2;
  fuselage.material = white;
  add(fuselage, [0, 0, 0]);

  // Rounded nose (stretched sphere, tip reaches about z = -7.7)
  const nose = MeshBuilder.CreateSphere("nose", { diameter: 2.38, segments: 24 }, scene);
  nose.scaling = new Vector3(0.98, 0.9, 1.65);
  nose.material = white;
  add(nose, [0, -0.12, -5.7]);

  // Cockpit windows — flattened dark band wrapping the upper nose
  const cockpit = MeshBuilder.CreateSphere("cockpit", { diameter: 1.9, segments: 20 }, scene);
  cockpit.scaling = new Vector3(0.98, 0.52, 0.95);
  cockpit.material = dark;
  add(cockpit, [0, 0.58, -6.45]);

  // Passenger window rows + doors on both sides
  for (const side of [-1, 1]) {
    for (let i = 0; i < 7; i++) {
      const win = MeshBuilder.CreateBox(
        `window-${side}-${i}`,
        { width: 0.1, height: 0.34, depth: 0.5 },
        scene,
      );
      win.material = dark;
      add(win, [side * 1.17, 0.38, -3.6 + i * 1.2]);
    }
    // Thin accent cheatline under the windows
    const cheatline = MeshBuilder.CreateBox(
      `cheatline-${side}`,
      { width: 0.1, height: 0.16, depth: 8.8 },
      scene,
    );
    cheatline.material = accent;
    add(cheatline, [side * 1.17, -0.05, 0]);
    // Front + rear doors
    for (const doorZ of [-4.5, 4.5]) {
      const door = MeshBuilder.CreateBox(
        `door-${side}-${doorZ}`,
        { width: 0.08, height: 1.05, depth: 0.6 },
        scene,
      );
      door.material = belly;
      add(door, [side * 1.18, -0.1, doorZ]);
    }
  }

  // Tail cone — small end (diameterTop) must point backward (+Z):
  // rotation.x = +PI/2 maps +Y to +Z, with a slight upsweep.
  const tailCone = MeshBuilder.CreateCylinder(
    "tail-cone",
    { diameterTop: 0.45, diameterBottom: 2.3, height: 3.9, tessellation: 24 },
    scene,
  );
  tailCone.rotation.x = Math.PI / 2 - 0.16;
  tailCone.material = white;
  add(tailCone, [0, 0.32, 7]);

  // APU exhaust at the very tip of the tail
  const apu = MeshBuilder.CreateCylinder(
    "apu",
    { diameter: 0.34, height: 0.35, tessellation: 12 },
    scene,
  );
  apu.rotation.x = Math.PI / 2 - 0.16;
  apu.material = intakeMat;
  add(apu, [0, 0.62, 8.95]);

  // Anti-collision beacon on top of the fuselage
  const beacon = MeshBuilder.CreateSphere("beacon", { diameter: 0.22, segments: 8 }, scene);
  beacon.material = beaconMat;
  add(beacon, [0, 1.24, 0.4]);

  // ---------- Wings (two swept halves with dihedral) ----------
  // Wing-root fairing blending the wing into the lower fuselage
  const fairing = MeshBuilder.CreateBox(
    "wing-fairing",
    { width: 3.2, height: 0.55, depth: 3.1 },
    scene,
  );
  fairing.material = belly;
  add(fairing, [0, -0.62, 0.25]);

  for (const side of [-1, 1]) {
    const wing = MeshBuilder.CreateBox(
      `wing-${side}`,
      { width: 6.6, height: 0.26, depth: 2.4 },
      scene,
    );
    // Sweep back ~13° and lift the tip ~5° (dihedral), mirrored per side
    wing.rotation.y = side * -0.22;
    wing.rotation.z = side * 0.085;
    wing.material = accent;
    add(wing, [side * 3.7, -0.5, 0.55]);

    // Winglet at the tip (swept-back position, standing up)
    const winglet = MeshBuilder.CreateBox(
      `winglet-${side}`,
      { width: 0.16, height: 1.05, depth: 1.15 },
      scene,
    );
    winglet.rotation.y = side * -0.22;
    winglet.material = orange;
    add(winglet, [side * 6.95, 0.05, 1.25]);

    // Navigation light on each wingtip: red left (port), green right (starboard)
    const nav = MeshBuilder.CreateSphere(
      `nav-light-${side}`,
      { diameter: 0.24, segments: 8 },
      scene,
    );
    nav.material = side < 0 ? navRed : navGreen;
    add(nav, [side * 7.05, -0.15, 1.15]);
  }

  // ---------- Engines (nacelle + dark intake + pylon, under each wing) ----------
  for (const side of [-1, 1]) {
    const pylon = MeshBuilder.CreateBox(
      `pylon-${side}`,
      { width: 0.2, height: 0.6, depth: 1.5 },
      scene,
    );
    pylon.material = belly;
    add(pylon, [side * 2.9, -0.72, -0.55]);

    const engine = MeshBuilder.CreateCylinder(
      `engine-${side}`,
      { diameter: 1.18, height: 2.9, tessellation: 22 },
      scene,
    );
    engine.rotation.x = Math.PI / 2;
    engine.material = metal;
    add(engine, [side * 2.9, -1.18, -0.75]);

    const intake = MeshBuilder.CreateCylinder(
      `engine-intake-${side}`,
      { diameter: 0.92, height: 0.2, tessellation: 22 },
      scene,
    );
    intake.rotation.x = Math.PI / 2;
    intake.material = intakeMat;
    add(intake, [side * 2.9, -1.18, -2.25]);
  }

  // ---------- Tail ----------
  // Vertical stabiliser, raked back, with a white rudder panel behind it
  const fin = MeshBuilder.CreateBox(
    "v-stabiliser",
    { width: 0.28, height: 3.1, depth: 2.3 },
    scene,
  );
  fin.rotation.x = 0.3;
  fin.material = orange;
  add(fin, [0, 2.15, 7.85]);

  const rudder = MeshBuilder.CreateBox(
    "rudder",
    { width: 0.3, height: 2.5, depth: 0.9 },
    scene,
  );
  rudder.rotation.x = 0.3;
  rudder.material = white;
  add(rudder, [0, 2.05, 9.05]);

  // Dorsal fin extension running forward from the fin base
  const dorsal = MeshBuilder.CreateBox(
    "dorsal-fin",
    { width: 0.2, height: 0.7, depth: 2.6 },
    scene,
  );
  dorsal.rotation.x = 0.18;
  dorsal.material = orange;
  add(dorsal, [0, 1.25, 6.1]);

  // Horizontal stabilisers — two small swept halves on the tail cone
  for (const side of [-1, 1]) {
    const stab = MeshBuilder.CreateBox(
      `h-stabiliser-${side}`,
      { width: 2.7, height: 0.18, depth: 1.05 },
      scene,
    );
    stab.rotation.y = side * -0.25;
    stab.rotation.z = side * 0.06;
    stab.material = accent;
    add(stab, [side * 1.6, 0.95, 8.15]);
  }

  // ---------- Landing gear (visual only) ----------
  // Wheel bottoms sit at local y = -2.25 for both nose and main gears.
  // Nose gear: single strut + twin wheels
  const noseStrut = MeshBuilder.CreateCylinder(
    "nose-gear-strut",
    { diameter: 0.16, height: 0.9, tessellation: 8 },
    scene,
  );
  noseStrut.material = metal;
  add(noseStrut, [0, -1.6, -5.1]);

  for (const side of [-1, 1]) {
    const wheel = MeshBuilder.CreateCylinder(
      `nose-wheel-${side}`,
      { diameter: 0.55, height: 0.18, tessellation: 14 },
      scene,
    );
    wheel.rotation.z = Math.PI / 2;
    wheel.material = tyre;
    add(wheel, [side * 0.2, -1.98, -5.1]);
  }

  // Main gears: strut + tandem pair of wheels per side
  for (const side of [-1, 1]) {
    const strut = MeshBuilder.CreateCylinder(
      `main-gear-strut-${side}`,
      { diameter: 0.2, height: 1.3, tessellation: 8 },
      scene,
    );
    strut.material = metal;
    add(strut, [side * 1.6, -1.28, 1.15]);

    for (const wheelZ of [0.8, 1.5]) {
      const wheel = MeshBuilder.CreateCylinder(
        `main-wheel-${side}-${wheelZ}`,
        { diameter: 0.8, height: 0.34, tessellation: 16 },
        scene,
      );
      wheel.rotation.z = Math.PI / 2;
      wheel.material = tyre;
      add(wheel, [side * 1.6, -1.85, wheelZ]);
    }
  }

  return root;
}
