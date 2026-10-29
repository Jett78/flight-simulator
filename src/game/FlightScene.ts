import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { createAirport } from "./createAirport";
import { createAirplane } from "./createAirplane";

/**
 * Owns the Babylon.js Engine + Scene for Phase 1.
 *
 * Responsibilities:
 * - sky background, fog, camera
 * - hemispheric + directional lighting with shadows
 * - airport environment + placeholder airplane
 * - render loop, window resize, and full disposal on unmount
 *
 * No flight physics or input controls live here yet (later phases).
 */
export class FlightScene {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly onResize = () => this.engine.resize();
  private disposed = false;

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

    this.createCamera(canvas);
    const shadowGenerator = this.createLights();
    this.buildWorld(shadowGenerator);

    window.addEventListener("resize", this.onResize);
    this.engine.runRenderLoop(() => {
      if (!this.disposed) this.scene.render();
    });
  }

  private createCamera(canvas: HTMLCanvasElement): ArcRotateCamera {
    // Orbit camera framing the runway, apron and the parked airplane.
    const camera = new ArcRotateCamera(
      "main-camera",
      -Math.PI / 2.35, // azimuth — looking in from the south-west
      Math.PI / 3.1, // beta — comfortably above the horizon
      105, // radius
      new Vector3(0, 2, 18),
      this.scene,
    );
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 18;
    camera.upperRadiusLimit = 320;
    camera.upperBetaLimit = Math.PI / 2.05; // never go under the ground
    camera.wheelPrecision = 8;
    camera.panningSensibility = 60;
    camera.inertia = 0.75;
    return camera;
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

  private buildWorld(shadows: ShadowGenerator): void {
    const airport = createAirport(this.scene);
    for (const mesh of airport.shadowCasters) shadows.addShadowCaster(mesh);

    // Placeholder airplane parked on the runway, nose toward -Z
    const airplane = createAirplane(this.scene);
    airplane.position = new Vector3(0, 2.05, 58);
    airplane.getChildMeshes().forEach((mesh) => shadows.addShadowCaster(mesh));
  }

  /** Stop the render loop and release all GPU / engine resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("resize", this.onResize);
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
