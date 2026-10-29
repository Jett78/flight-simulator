import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { createAirport } from "./createAirport";
import { createAirplane } from "./createAirplane";

/**
 * Coordinate convention (shared by the airplane model and this camera):
 *   forward = -Z, up = +Y, right = +X. The aircraft root is never rotated
 *   away from that convention in Phase 2; the chase math below works for
 *   any future yaw/pitch/roll because it uses the root's world rotation.
 */

/** Runway centreline, near the southern threshold, nose pointing down -Z
 *  so ~178m of runway lies ahead. y = runway top (0.16) + gear depth (2.25). */
const AIRCRAFT_START = new Vector3(0, 2.41, 68);

/** Chase offset in aircraft-local space: behind (+Z) and above (+Y). */
const CHASE_OFFSET = new Vector3(0, 4.4, 14);
/** Look-at offset in aircraft-local space: slightly above the fuselage
 *  and ahead of the nose, so the plane sits low-centre in frame. */
const CHASE_LOOK_OFFSET = new Vector3(0, 1.1, -8);

/** Frame-rate independent exponential damping rates (per second).
 *  Position trails a little more than the look target, which keeps the
 *  framing stable without visible lag or snapping. */
const POSITION_DAMPING = 3.4;
const TARGET_DAMPING = 5.5;

/**
 * Owns the Babylon.js Engine + Scene.
 *
 * Phase 2: improved airplane on the runway start position, followed by a
 * smoothed third-person chase camera with a reset function (HUD button
 * or the R key). Still no flight physics or flight controls.
 */
export class FlightScene {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: FreeCamera;
  private readonly aircraft: TransformNode;
  private readonly smoothedTarget = new Vector3();
  private readonly onResize = () => this.engine.resize();
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "r" || event.key === "R") this.resetCamera();
  };
  private disposed = false;

  // Scratch objects reused every frame (no per-frame allocation)
  private readonly _quat = new Quaternion();
  private readonly _rotMatrix = new Matrix();
  private readonly _desiredPos = new Vector3();
  private readonly _desiredTarget = new Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, {
      antialias: true,
      stencil: true,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });

    this.scene = new Scene(this.engine);
    // Clean sky
    this.scene.clearColor = new Color4(0.47, 0.71, 0.96, 1);
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogDensity = 0.0009;
    this.scene.fogColor = new Color3(0.62, 0.78, 0.95);

    const shadowGenerator = this.createLights();
    this.aircraft = this.buildWorld(shadowGenerator);

    this.camera = new FreeCamera("chase-camera", AIRCRAFT_START.clone(), this.scene);
    this.camera.minZ = 0.1;
    this.camera.maxZ = 1200;
    this.camera.fov = 0.82;
    this.resetCamera(); // snap straight to the chase pose, no opening swoop

    this.scene.onBeforeRenderObservable.add(() => this.updateChaseCamera());

    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKeyDown);
    this.engine.runRenderLoop(() => {
      if (!this.disposed) this.scene.render();
    });
  }

  /** World-space chase pose for the aircraft's current transform. */
  private computeChasePose(outPos: Vector3, outTarget: Vector3): void {
    const node = this.aircraft;
    if (node.rotationQuaternion) {
      this._quat.copyFrom(node.rotationQuaternion);
    } else {
      Quaternion.RotationYawPitchRollToRef(
        node.rotation.y,
        node.rotation.x,
        node.rotation.z,
        this._quat,
      );
    }
    Matrix.FromQuaternionToRef(this._quat, this._rotMatrix);
    // Offset rotated into world space (rotation only, no translation)
    Vector3.TransformNormalToRef(CHASE_OFFSET, this._rotMatrix, outPos);
    outPos.addInPlace(node.position);
    Vector3.TransformNormalToRef(CHASE_LOOK_OFFSET, this._rotMatrix, outTarget);
    outTarget.addInPlace(node.position);
  }

  private updateChaseCamera(): void {
    // Clamp dt so a background tab / hitch can't make the camera jump
    const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.05);
    this.computeChasePose(this._desiredPos, this._desiredTarget);

    const posAlpha = 1 - Math.exp(-POSITION_DAMPING * dt);
    const targetAlpha = 1 - Math.exp(-TARGET_DAMPING * dt);
    Vector3.LerpToRef(this.camera.position, this._desiredPos, posAlpha, this.camera.position);
    Vector3.LerpToRef(this.smoothedTarget, this._desiredTarget, targetAlpha, this.smoothedTarget);
    this.camera.setTarget(this.smoothedTarget);
  }

  /** Snap the chase camera back behind/above the aircraft, instantly. */
  resetCamera(): void {
    this.computeChasePose(this._desiredPos, this._desiredTarget);
    this.camera.position.copyFrom(this._desiredPos);
    this.smoothedTarget.copyFrom(this._desiredTarget);
    this.camera.setTarget(this.smoothedTarget);
  }

  private createLights(): ShadowGenerator {
    const hemi = new HemisphericLight("hemi-light", new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.85;
    hemi.diffuse = new Color3(0.85, 0.92, 1);
    hemi.groundColor = new Color3(0.35, 0.42, 0.3);
    hemi.specular = new Color3(0.2, 0.2, 0.2);

    const sun = new DirectionalLight(
      "sun-light",
      new Vector3(-0.55, -1, -0.35),
      this.scene,
    );
    sun.position = new Vector3(70, 95, 45);
    sun.intensity = 1.25;
    sun.diffuse = new Color3(1, 0.97, 0.9);
    // Cover the airport (runway is 220 long) with the shadow frustum
    sun.autoCalcShadowZBounds = true;
    sun.shadowMinZ = 10;
    sun.shadowMaxZ = 260;
    (sun as unknown as { orthoLeft: number }).orthoLeft = -140;
    (sun as unknown as { orthoRight: number }).orthoRight = 140;
    (sun as unknown as { orthoTop: number }).orthoTop = 140;
    (sun as unknown as { orthoBottom: number }).orthoBottom = -140;

    const shadows = new ShadowGenerator(2048, sun);
    shadows.useBlurExponentialShadowMap = true;
    shadows.blurKernel = 24;
    shadows.darkness = 0.35;
    return shadows;
  }

  private buildWorld(shadows: ShadowGenerator): TransformNode {
    const airport = createAirport(this.scene);
    for (const mesh of airport.shadowCasters) shadows.addShadowCaster(mesh);

    const airplane = createAirplane(this.scene);
    airplane.position.copyFrom(AIRCRAFT_START);
    airplane.getChildMeshes().forEach((mesh) => shadows.addShadowCaster(mesh));
    return airplane;
  }

  /** Stop the render loop and release all GPU / engine resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("keydown", this.onKeyDown);
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
