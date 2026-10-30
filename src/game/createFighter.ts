import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { createMaterial } from "./materials";

/**
 * Procedural fighter jet (Multi-aircraft Phase 4), built from
 * Babylon.js primitives in the same style and conventions as
 * createAirplane.ts:
 *   forward = -Z (nose), up = +Y, right wing = +X;
 *   wheels touch the ground at local y ≈ -2.25;
 *   everything hangs under one root TransformNode.
 *
 * This is the Falcon F1's own model — grey delta-wing jet with
 * canted twin tails, side intakes and twin exhausts — distinct
 * from both the Cesium Air GLB and the procedural airliner. If a
 * licensed GLB is supplied later, the config's modelPath takes
 * over and this builder becomes the fallback (see ASSETS.md).
 *
 * Authored ≈12.5 m long; FlightScene normalizes it to the
 * config's fitted length (11 m × config scale) and re-seats the
 * underside onto the gear contact, exactly like the GLB fit.
 */
export function createFighterJet(scene: Scene): TransformNode {
  const root = new TransformNode("fighter", scene);

  const body = createMaterial(scene, "fighter-body", 0.52, 0.55, 0.6, { specular: 0.45 });
  const wingMat = createMaterial(scene, "fighter-wing", 0.36, 0.39, 0.44, { specular: 0.35 });
  const dark = createMaterial(scene, "fighter-dark", 0.06, 0.08, 0.12, { specular: 0.7 });
  const accent = createMaterial(scene, "fighter-accent", 0.85, 0.32, 0.08, { specular: 0.3 });
  const metal = createMaterial(scene, "fighter-metal", 0.5, 0.52, 0.56, { specular: 0.55 });
  const tyre = createMaterial(scene, "fighter-tyre", 0.05, 0.05, 0.06, { specular: 0.05 });
  const intakeMat = createMaterial(scene, "fighter-intake", 0.03, 0.03, 0.04, { specular: 0.1 });
  const navRed = createMaterial(scene, "fighter-nav-red", 0.6, 0.05, 0.05, {
    emissive: [0.9, 0.08, 0.08],
  });
  const navGreen = createMaterial(scene, "fighter-nav-green", 0.05, 0.6, 0.15, {
    emissive: [0.08, 0.9, 0.2],
  });
  const beaconMat = createMaterial(scene, "fighter-beacon", 0.7, 0.05, 0.05, {
    emissive: [1, 0.1, 0.1],
  });

  const add = (mesh: Mesh, position: [number, number, number]) => {
    mesh.position = new Vector3(...position);
    mesh.parent = root;
    mesh.receiveShadows = false;
    return mesh;
  };

  // ---------- Fuselage ----------
  // Main body: flattened ellipsoid, z from about -4.3 to +3.3
  const fuselage = MeshBuilder.CreateSphere("fighter-fuselage", { diameter: 2.2, segments: 24 }, scene);
  fuselage.scaling = new Vector3(0.62, 0.55, 3.4);
  fuselage.material = body;
  add(fuselage, [0, 0, -0.5]);

  // Long pointed radome: small end (diameterTop) must face -Z,
  // so rotation.x = -PI/2 maps the cylinder's +Y onto -Z.
  const nose = MeshBuilder.CreateCylinder(
    "fighter-nose",
    { diameterTop: 0.04, diameterBottom: 1.02, height: 3.6, tessellation: 20 },
    scene,
  );
  nose.rotation.x = -Math.PI / 2;
  nose.material = body;
  add(nose, [0, -0.06, -5.9]);

  // Pitot probe at the very tip
  const probe = MeshBuilder.CreateCylinder(
    "fighter-probe",
    { diameter: 0.035, height: 0.9, tessellation: 6 },
    scene,
  );
  probe.rotation.x = Math.PI / 2;
  probe.material = metal;
  add(probe, [0, -0.06, -8.05]);

  // Canopy — dark glossy teardrop over the front fuselage
  const canopy = MeshBuilder.CreateSphere("fighter-canopy", { diameter: 1.5, segments: 20 }, scene);
  canopy.scaling = new Vector3(0.72, 0.5, 1.55);
  canopy.material = dark;
  add(canopy, [0, 0.52, -2.3]);

  // Spine fairing running back from the canopy
  const spine = MeshBuilder.CreateBox("fighter-spine", { width: 0.5, height: 0.34, depth: 3.6 }, scene);
  spine.material = wingMat;
  add(spine, [0, 0.55, 0.6]);

  // Accent stripes along both flanks
  for (const side of [-1, 1]) {
    const stripe = MeshBuilder.CreateBox(
      `fighter-stripe-${side}`,
      { width: 0.06, height: 0.2, depth: 5.6 },
      scene,
    );
    stripe.material = accent;
    add(stripe, [side * 0.66, 0.08, -0.9]);
  }

  // ---------- Delta wing ----------
  // Centre glove blending wing into body, then two strongly
  // swept outer panels — together they read as a delta.
  const glove = MeshBuilder.CreateBox("fighter-glove", { width: 3.6, height: 0.3, depth: 3.8 }, scene);
  glove.material = wingMat;
  add(glove, [0, -0.3, 1.0]);

  for (const side of [-1, 1]) {
    const wing = MeshBuilder.CreateBox(
      `fighter-wing-${side}`,
      { width: 4.8, height: 0.17, depth: 3.3 },
      scene,
    );
    wing.rotation.y = side * -0.62; // ~35° sweep
    wing.rotation.z = side * 0.03;
    wing.material = wingMat;
    add(wing, [side * 2.45, -0.3, 1.5]);

    const nav = MeshBuilder.CreateSphere(`fighter-nav-${side}`, { diameter: 0.2, segments: 8 }, scene);
    nav.material = side < 0 ? navRed : navGreen;
    add(nav, [side * 4.85, -0.22, 2.6]);
  }

  // ---------- Intakes (one per flank, dark face forward) ----------
  for (const side of [-1, 1]) {
    const intake = MeshBuilder.CreateBox(
      `fighter-intake-box-${side}`,
      { width: 0.6, height: 0.62, depth: 2.3 },
      scene,
    );
    intake.material = body;
    add(intake, [side * 0.98, -0.45, -0.7]);

    const face = MeshBuilder.CreateBox(
      `fighter-intake-face-${side}`,
      { width: 0.5, height: 0.5, depth: 0.08 },
      scene,
    );
    face.material = intakeMat;
    add(face, [side * 0.98, -0.45, -1.88]);
  }

  // ---------- Twin canted tails + tailerons ----------
  for (const side of [-1, 1]) {
    const fin = MeshBuilder.CreateBox(
      `fighter-fin-${side}`,
      { width: 0.15, height: 1.75, depth: 1.5 },
      scene,
    );
    fin.rotation.x = 0.32; // raked back
    fin.rotation.z = side * -0.22; // canted outward
    fin.material = wingMat;
    add(fin, [side * 0.88, 1.2, 3.6]);

    const tip = MeshBuilder.CreateBox(
      `fighter-fin-tip-${side}`,
      { width: 0.17, height: 0.34, depth: 1.1 },
      scene,
    );
    tip.rotation.x = 0.32;
    tip.rotation.z = side * -0.22;
    tip.material = accent;
    add(tip, [side * 1.06, 2.0, 3.95]);

    const stab = MeshBuilder.CreateBox(
      `fighter-stab-${side}`,
      { width: 2.1, height: 0.13, depth: 1.0 },
      scene,
    );
    stab.rotation.y = side * -0.42;
    stab.material = wingMat;
    add(stab, [side * 1.45, 0.05, 4.35]);
  }

  // ---------- Twin exhausts ----------
  for (const side of [-1, 1]) {
    const nozzle = MeshBuilder.CreateCylinder(
      `fighter-nozzle-${side}`,
      { diameter: 0.56, height: 0.75, tessellation: 14 },
      scene,
    );
    nozzle.rotation.x = Math.PI / 2;
    nozzle.material = metal;
    add(nozzle, [side * 0.42, 0.02, 4.15]);

    const glow = MeshBuilder.CreateCylinder(
      `fighter-exhaust-${side}`,
      { diameter: 0.44, height: 0.1, tessellation: 14 },
      scene,
    );
    glow.rotation.x = Math.PI / 2;
    glow.material = intakeMat;
    add(glow, [side * 0.42, 0.02, 4.55]);
  }

  // Anti-collision beacon
  const beacon = MeshBuilder.CreateSphere("fighter-beacon-dot", { diameter: 0.18, segments: 8 }, scene);
  beacon.material = beaconMat;
  add(beacon, [0, 0.78, 1.9]);

  // ---------- Landing gear (visual only; bottoms at y = -2.25) ----------
  const noseStrut = MeshBuilder.CreateCylinder(
    "fighter-nose-strut",
    { diameter: 0.13, height: 1.5, tessellation: 8 },
    scene,
  );
  noseStrut.material = metal;
  add(noseStrut, [0, -1.35, -4.4]);

  const noseWheel = MeshBuilder.CreateCylinder(
    "fighter-nose-wheel",
    { diameter: 0.5, height: 0.16, tessellation: 12 },
    scene,
  );
  noseWheel.rotation.z = Math.PI / 2;
  noseWheel.material = tyre;
  add(noseWheel, [0, -2.0, -4.4]);

  for (const side of [-1, 1]) {
    const strut = MeshBuilder.CreateCylinder(
      `fighter-main-strut-${side}`,
      { diameter: 0.16, height: 1.35, tessellation: 8 },
      scene,
    );
    strut.material = metal;
    add(strut, [side * 1.05, -1.3, 1.7]);

    const wheel = MeshBuilder.CreateCylinder(
      `fighter-main-wheel-${side}`,
      { diameter: 0.72, height: 0.26, tessellation: 14 },
      scene,
    );
    wheel.rotation.z = Math.PI / 2;
    wheel.material = tyre;
    add(wheel, [side * 1.05, -1.89, 1.7]);
  }

  return root;
}
