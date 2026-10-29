import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { AircraftController, type FlightState } from "./AircraftController";
import { loadAircraftModel } from "./aircraftModel";
import { createAirport } from "./createAirport";
import { createAirplane } from "./createAirplane";
import { createIsland } from "./createIsland";
import { InputManager } from "./InputManager";
import { createGroundSampler } from "./runway";

/**
 * Coordinate convention (shared by the airplane model, the controller
 * and this camera): forward = -Z, up = +Y, right = +X.
 */

/** Runway centreline, near the southern threshold, nose pointing down -Z
 *  so ~178m of runway lies ahead. y = runway top (0.16) + gear depth (2.25). */
const AIRCRAFT_START = new Vector3(0, 2.41, 68);

/**
 * Physics runs at a fixed 120 Hz timestep through an accumulator, so
 * the simulation is identical at 30, 60 or 144 fps. Frame time is
 * clamped to 100 ms: after a tab switch or long pause the game slows
 * briefly instead of exploding, and leftover time is dropped rather
 * than spiralling (max ~16 steps per frame).
 */
const FIXED_DT = 1 / 120;
const MAX_FRAME_DT = 0.1;
const MAX_PHYSICS_STEPS = 16;

interface CameraMode {
  name: string;
  /** Camera position in aircraft-local space. */
  offset: Vector3;
  /** Look-at point in aircraft-local space. */
  lookOffset: Vector3;
  /** Exponential damping rates (per second) for position / target. */
  posDamp: number;
  targetDamp: number;
}

/**
 * Camera modes, cycled with the C key (Phase 3). Offsets are behind
 * (+Z) and above (+Y) the aircraft, except Cockpit, which sits at the
 * pilot's head and is damped so hard it is effectively rigid.
 */
const CAMERA_MODES: CameraMode[] = [
  {
    name: "Chase",
    offset: new Vector3(0, 4.4, 14),
    lookOffset: new Vector3(0, 1.1, -8),
    posDamp: 3.4,
    targetDamp: 5.5,
  },
  {
    name: "Chase far",
    offset: new Vector3(0, 7.5, 27),
    lookOffset: new Vector3(0, 1.2, -10),
    posDamp: 3.4,
    targetDamp: 5.5,
  },
  {
    name: "Cockpit",
    // Placeholder eye point (just above its fuselage). When the
    // GLB model loads, buildWorld re-seats this preset to the
    // model's cabin — see COCKPIT_MODEL below.
    offset: new Vector3(0, 1.7, -4.8),
    lookOffset: new Vector3(0, 1.15, -30),
    posDamp: 40,
    targetDamp: 40,
  },
];

/**
 * Cockpit preset for the GLB model (Phase 8): the model's fuselage
 * sits low (centreline top ≈ −0.4 in root space, nose tip −1.41),
 * so the eye goes just above the cabin roof at z −1.0 and the view
 * tilts down enough to put the nose band (z −3.5…−5.5) in the
 * lower quarter of the frame — measured from the fitted model's
 * actual cross-section, after two level-eye attempts left the nose
 * below the frame entirely.
 */
const COCKPIT_MODEL = {
  offset: new Vector3(0, 0.55, -1.0),
  lookOffset: new Vector3(0, -3.5, -30),
};

/**
 * Owns the Babylon.js Engine + Scene.
 *
 * Phase 4 wiring: InputManager (keyboard) -> AircraftController
 * (force-based flight model, stepped at a fixed 120 Hz through an
 * accumulator) -> chase camera at render rate. Rendering stays
 * separate from simulation: the controller never touches the camera
 * or the scene.
 */
export class FlightScene {
  /** Optional UI callbacks, assigned by the React host. */
  onCameraModeChange?: (modeName: string) => void;
  onTelemetry?: (state: FlightState) => void;

  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: FreeCamera;
  private readonly aircraft: TransformNode;
  private readonly input: InputManager;
  private readonly controller: AircraftController;
  private readonly smoothedTarget = new Vector3();
  private readonly onResize = () => this.engine.resize();
  private cameraModeIndex = 0;
  private telemetryTimer = 0;
  private physicsAccumulator = 0;
  private disposed = false;
  private paused = false;

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
    // Phase 5: island scale (~2.8 km across) needs much thinner fog
    // than the Phase 1 airfield-only scene — this keeps the far
    // mountains hazed but visible from cruise altitude.
    this.scene.fogDensity = 0.00036;
    this.scene.fogColor = new Color3(0.66, 0.8, 0.94);

    const shadowGenerator = this.createLights();
    this.aircraft = this.buildWorld(shadowGenerator);

    this.input = new InputManager();
    // Phase 7: the controller judges ground contact, touchdowns and
    // crashes against the real island/runway ground sampler.
    this.controller = new AircraftController(this.aircraft, AIRCRAFT_START, createGroundSampler());

    // Development-only debug handle (Phase 4 §6): in `npm run dev`,
    // open the console and use __flightSim.state() / __flightSim.reset()
    if (import.meta.env.DEV) {
      const debugWindow = window as unknown as { __flightSim?: unknown };
      debugWindow.__flightSim = {
        state: () => this.controller.getState(),
        reset: () => this.resetAircraft(),
        controller: this.controller,
      };
    }

    this.camera = new FreeCamera("chase-camera", AIRCRAFT_START.clone(), this.scene);
    this.camera.minZ = 0.1;
    this.camera.maxZ = 5200; // island + sky dome (radius 4200) in view
    this.camera.fov = 0.82;
    this.resetCamera(); // snap straight to the chase pose, no opening swoop

    this.scene.onBeforeRenderObservable.add(() => this.update());

    window.addEventListener("resize", this.onResize);
    this.engine.runRenderLoop(() => {
      if (!this.disposed) this.scene.render();
    });
  }

  private get cameraMode(): CameraMode {
    return CAMERA_MODES[this.cameraModeIndex];
  }

  /**
   * Pause the simulation (Phase 6 HUD button / P key). Physics and
   * the camera freeze; rendering continues so the window still
   * resizes and repaints. Input edges are drained while paused so a
   * key pressed during the pause never fires on resume.
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.physicsAccumulator = 0;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** One frame: input actions -> fixed-step physics -> camera -> HUD. */
  private update(): void {
    if (this.paused) {
      this.input.postUpdate();
      return;
    }
    // Clamp frame time so pauses/tab switches can't destabilise physics
    const frameDt = Math.min(this.engine.getDeltaTime() / 1000, MAX_FRAME_DT);

    if (this.input.wasJustPressed("KeyR")) this.resetAircraft();
    if (this.input.wasJustPressed("KeyC")) this.cycleCameraMode();

    // Fixed-timestep physics, independent of the render frame rate
    this.physicsAccumulator += frameDt;
    let steps = 0;
    while (this.physicsAccumulator >= FIXED_DT && steps < MAX_PHYSICS_STEPS) {
      this.controller.step(FIXED_DT, this.input);
      this.physicsAccumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_PHYSICS_STEPS) this.physicsAccumulator = 0;

    this.updateChaseCamera(frameDt);

    this.telemetryTimer += frameDt;
    if (this.telemetryTimer >= 0.15) {
      this.telemetryTimer = 0;
      this.onTelemetry?.(this.controller.getState());
    }

    this.input.postUpdate();
  }

  /** Clean programmatic access to the simulation state (HUD/debugging). */
  getFlightState(): FlightState {
    return this.controller.getState();
  }

  /** R: restore the aircraft to its start state and re-frame it. */
  resetAircraft(): void {
    this.controller.reset();
    this.physicsAccumulator = 0;
    this.resetCamera();
  }

  /** C: cycle Chase -> Chase far -> Cockpit -> Chase ... */
  cycleCameraMode(): void {
    const previous = this.cameraMode.name;
    this.cameraModeIndex = (this.cameraModeIndex + 1) % CAMERA_MODES.length;
    // Snap when entering or leaving Cockpit so the camera never
    // sweeps through the airframe; chase modes glide smoothly.
    if (previous === "Cockpit" || this.cameraMode.name === "Cockpit") {
      this.resetCamera();
    }
    this.onCameraModeChange?.(this.cameraMode.name);
  }

  /** World-space camera pose for the aircraft's current transform. */
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
    const mode = this.cameraMode;
    // Offsets rotated into world space (rotation only, no translation)
    Vector3.TransformNormalToRef(mode.offset, this._rotMatrix, outPos);
    outPos.addInPlace(node.position);
    Vector3.TransformNormalToRef(mode.lookOffset, this._rotMatrix, outTarget);
    outTarget.addInPlace(node.position);
  }

  private updateChaseCamera(dt: number): void {
    this.computeChasePose(this._desiredPos, this._desiredTarget);
    const mode = this.cameraMode;
    const posAlpha = 1 - Math.exp(-mode.posDamp * dt);
    const targetAlpha = 1 - Math.exp(-mode.targetDamp * dt);
    Vector3.LerpToRef(this.camera.position, this._desiredPos, posAlpha, this.camera.position);
    Vector3.LerpToRef(this.smoothedTarget, this._desiredTarget, targetAlpha, this.smoothedTarget);
    this.camera.setTarget(this.smoothedTarget);
  }

  /** Snap the camera back to the current mode's pose, instantly. */
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
    // Island first: its terrain is flat y=0 across the airport pad,
    // so the airport meshes sit on it exactly as on the old ground.
    createIsland(this.scene);
    const airport = createAirport(this.scene);
    for (const mesh of airport.shadowCasters) shadows.addShadowCaster(mesh);

    const airplane = createAirplane(this.scene);
    airplane.position.copyFrom(AIRCRAFT_START);
    airplane.getChildMeshes().forEach((mesh) => shadows.addShadowCaster(mesh));
    // Phase 8: swap the placeholder for the GLB model when it loads.
    // Async and fully optional — on any failure the placeholder
    // stays and the simulation is unaffected. On success, re-seat
    // the cockpit camera to the model's cabin.
    void loadAircraftModel(this.scene, airplane, (mesh) => shadows.addShadowCaster(mesh)).then(
      (loaded) => {
        if (!loaded) return;
        const cockpit = CAMERA_MODES.find((m) => m.name === "Cockpit");
        if (cockpit) {
          cockpit.offset.copyFrom(COCKPIT_MODEL.offset);
          cockpit.lookOffset.copyFrom(COCKPIT_MODEL.lookOffset);
        }
      },
    );
    return airplane;
  }

  /** Stop the render loop and release all GPU / engine resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("resize", this.onResize);
    this.input.dispose();
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
