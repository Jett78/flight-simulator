import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Scene } from "@babylonjs/core/scene";
import { createMaterial } from "./materials";

/**
 * Placeholder airplane built only from Babylon.js primitives.
 * Model axis: nose points toward -Z, wings span X, up is +Y.
 * The returned node is positioned on the runway by the caller.
 */
export function createAirplane(scene: Scene): TransformNode {
  const root = new TransformNode("airplane", scene);

  const white = createMaterial(scene, "plane-white", 0.93, 0.94, 0.96, { specular: 0.35 });
  const accent = createMaterial(scene, "plane-accent", 0.08, 0.35, 0.75, { specular: 0.3 });
  const orange = createMaterial(scene, "plane-orange", 0.95, 0.45, 0.08, { specular: 0.25 });
  const dark = createMaterial(scene, "plane-dark", 0.07, 0.1, 0.16, { specular: 0.6 });
  const metal = createMaterial(scene, "plane-metal", 0.55, 0.58, 0.62, { specular: 0.5 });
  const tyre = createMaterial(scene, "plane-tyre", 0.05, 0.05, 0.06, { specular: 0.05 });

  const add = (mesh: Mesh, position: [number, number, number]) => {
    mesh.position = new Vector3(...position);
    mesh.parent = root;
    mesh.receiveShadows = false;
    return mesh;
  };

  // --- Fuselage (cylinder along Z) ---
  const fuselage = MeshBuilder.CreateCylinder(
    "fuselage",
    { diameter: 2.3, height: 11, tessellation: 24 },
    scene,
  );
  fuselage.rotation.x = Math.PI / 2;
  fuselage.material = white;
  add(fuselage, [0, 0, 0]);

  // Nose (stretched sphere at the front, -Z)
  const nose = MeshBuilder.CreateSphere(
    "nose",
    { diameter: 2.3, segments: 20 },
    scene,
  );
  nose.scaling = new Vector3(1, 0.92, 1.5);
  nose.material = white;
  add(nose, [0, -0.05, -5.6]);

  // Cockpit windows (dark band on the nose, slightly above centre)
  const cockpit = MeshBuilder.CreateSphere(
    "cockpit",
    { diameter: 1.9, segments: 16 },
    scene,
  );
  cockpit.scaling = new Vector3(0.92, 0.55, 0.9);
  cockpit.material = dark;
  add(cockpit, [0, 0.55, -6.15]);

  // Tail cone (tapered cylinder toward the rear, +Z)
  const tailCone = MeshBuilder.CreateCylinder(
    "tail-cone",
    { diameterTop: 0.55, diameterBottom: 2.15, height: 3.6, tessellation: 20 },
    scene,
  );
  tailCone.rotation.x = -Math.PI / 2;
  tailCone.material = white;
  add(tailCone, [0, 0.25, 7]);

  // Belly stripe (thin accent box running under the windows line)
  const stripe = MeshBuilder.CreateBox(
    "stripe",
    { width: 2.34, height: 0.42, depth: 8.5 },
    scene,
  );
  stripe.material = accent;
  add(stripe, [0, 0.18, -0.6]);

  // --- Wings ---
  const mainWing = MeshBuilder.CreateBox(
    "main-wing",
    { width: 13.5, height: 0.28, depth: 2.3 },
    scene,
  );
  mainWing.material = accent;
  add(mainWing, [0, -0.35, -0.4]);

  // Wing tips (orange caps make the silhouette easy to read)
  for (const side of [-1, 1]) {
    const tip = MeshBuilder.CreateBox(
      `wing-tip-${side}`,
      { width: 0.9, height: 0.7, depth: 2.1 },
      scene,
    );
    tip.material = orange;
    add(tip, [side * 6.7, -0.15, -0.4]);
  }

  // Horizontal stabiliser
  const hStab = MeshBuilder.CreateBox(
    "h-stabiliser",
    { width: 5.2, height: 0.22, depth: 1.3 },
    scene,
  );
  hStab.material = accent;
  add(hStab, [0, 0.75, 8.2]);

  // Vertical stabiliser (tail fin)
  const vStab = MeshBuilder.CreateBox(
    "v-stabiliser",
    { width: 0.28, height: 2.9, depth: 1.9 },
    scene,
  );
  vStab.material = orange;
  add(vStab, [0, 1.9, 8]);

  // --- Engines (two cylinders slung under the main wing) ---
  for (const side of [-1, 1]) {
    const engine = MeshBuilder.CreateCylinder(
      `engine-${side}`,
      { diameter: 1.05, height: 2.4, tessellation: 18 },
      scene,
    );
    engine.rotation.x = Math.PI / 2;
    engine.material = metal;
    add(engine, [side * 3.1, -0.95, -0.7]);

    const intake = MeshBuilder.CreateCylinder(
      `engine-intake-${side}`,
      { diameter: 0.82, height: 0.18, tessellation: 18 },
      scene,
    );
    intake.rotation.x = Math.PI / 2;
    intake.material = new StandardMaterial(`intake-mat-${side}`, scene);
    (intake.material as StandardMaterial).diffuseColor = new Color3(0.04, 0.04, 0.05);
    add(intake, [side * 3.1, -0.95, -1.95]);
  }

  // --- Landing gear (struts + wheels, purely visual in Phase 1) ---
  const gearPositions: Array<[number, number, number]> = [
    [0, -1.55, -4.4], // nose gear
    [-1.5, -1.55, 0.6], // left main gear
    [1.5, -1.55, 0.6], // right main gear
  ];
  gearPositions.forEach(([x, y, z], i) => {
    const strut = MeshBuilder.CreateCylinder(
      `gear-strut-${i}`,
      { diameter: 0.16, height: 0.9, tessellation: 8 },
      scene,
    );
    strut.material = metal;
    add(strut, [x, y + 0.45, z]);

    const wheel = MeshBuilder.CreateCylinder(
      `gear-wheel-${i}`,
      { diameter: 0.72, height: 0.32, tessellation: 16 },
      scene,
    );
    wheel.rotation.z = Math.PI / 2;
    wheel.material = tyre;
    add(wheel, [x, y, z]);
  });

  return root;
}
