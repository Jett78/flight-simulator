import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
import { Scene } from "@babylonjs/core/scene";
import { AircraftController, type FlightState } from "./AircraftController";
import {
  createCheckpointMarkers,
  type CheckpointMarkerHandle,
} from "./checkpointMarkers";
import type { CheckpointVisual } from "./missions";
import { loadAircraftModel, modelSourceFor, normalizeProceduralModel } from "./aircraftModel";
import { createFighterJet } from "./createFighter";
import {
  aircraftVariantById,
  loadAircraftVariantId,
  saveAircraftVariantId,
} from "./aircraftVariants";
import { getAircraftConfig, type AircraftConfig } from "./aircraftConfigs";
import { createAirport } from "./createAirport";
import { createAirplane } from "./createAirplane";
import { createIsland } from "./createIsland";
import { InputManager } from "./InputManager";
import { createGroundSampler } from "./runway";
import { ObstacleField } from "./obstacles";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import type { GroundSampler } from "./AircraftController";

/**
 * Coordinate convention (shared by the airplane model, the controller
 * and this camera): forward = -Z, up = +Y, right = +X.
 */

/** Runway centreline, near the southern threshold, nose pointing down -Z
 *  so ~178m of runway lies ahead. y = runway top (0.16) + gear depth (2.25). */
const AIRCRAFT_START = new Vector3(0, 2.41, 105); // 300 m runway: 195 m of asphalt ahead

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
const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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
 * Multi-aircraft Phase 1: seat the camera presets from the
 * active aircraft's config. The defaults above are the Cesium
 * Air's values, and the default config carries those same
 * numbers, so this is a no-op for the current game — it exists
 * so a bigger or smaller aircraft (Phase 2+) frames correctly.
 * Note the GLB cockpit re-seat (COCKPIT_MODEL) still runs after
 * the default model loads, exactly as before.
 */
function applyCameraConfig(cfg: AircraftConfig): void {
  const set = (name: string, pose: AircraftConfig["camera"]["chase"]) => {
    const mode = CAMERA_MODES.find((m) => m.name === name);
    if (!mode) return;
    mode.offset.set(pose.offset[0], pose.offset[1], pose.offset[2]);
    mode.lookOffset.set(pose.lookOffset[0], pose.lookOffset[1], pose.lookOffset[2]);
  };
  set("Chase", cfg.camera.chase);
  set("Chase far", cfg.camera.chaseFar);
  set("Cockpit", cfg.camera.cockpit);
  // Phase 5: the chase modes also take the aircraft's follow
  // damping (the cockpit keeps its rigid 40/40 for everyone).
  for (const name of ["Chase", "Chase far"]) {
    const mode = CAMERA_MODES.find((m) => m.name === name);
    if (!mode) continue;
    mode.posDamp = cfg.camera.followPosDamp;
    mode.targetDamp = cfg.camera.followTargetDamp;
  }
}

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
  /** Phase 14: gamepad connect/disconnect, for the HUD chip. */
  onGamepadConnectionChange?: (connected: boolean) => void;

  /**
   * Multi-aircraft: the active aircraft configuration, chosen
   * on the Phase 2 selection screen and passed to the
   * constructor; defaults to the Cesium Air.
   */
  readonly aircraftConfig: AircraftConfig;

  /** Phase 4: which visual the aircraft root is wearing. */
  private modelKind: "gltf" | "procedural" | "placeholder" = "placeholder";

  /** Phase 14: original paint colours, captured before any tint. */
  private readonly paintOriginals = new Map<number, Color3>();

  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: FreeCamera;
  private readonly aircraft: TransformNode;
  private readonly input: InputManager;
  private readonly controller: AircraftController;
  private readonly smoothedTarget = new Vector3();
  private readonly onResize = () => this.engine.resize();
  private cameraModeIndex = 0;
  // Phase 12 drag-look: orbit offsets (radians) applied to the
  // camera rig in aircraft-local space; zero = the mode's default
  // view. Driven by pointer drags on the canvas (see
  // attachDragLook), cleared by resetCamera().
  private viewYaw = 0;
  private viewPitch = 0;
  private readonly _orbitQuat = new Quaternion();
  private readonly _orbitVec = new Vector3();
  private dragLookDispose: (() => void) | null = null;
  private obstacleField: ObstacleField | null = null;
  // Phase 13 explosion state
  private wasCrashed = false;
  private shakeTime = 0;
  private explosionFx: Array<{ systems: ParticleSystem[]; light: PointLight | null; ttl: number }> = [];
  /** Camera-only ground sampler: keeps an orbited camera out of the terrain. */
  private readonly cameraSampler: GroundSampler = createGroundSampler();
  private telemetryTimer = 0;
  private physicsAccumulator = 0;
  private checkpointMarkers: CheckpointMarkerHandle | null = null;
  private checkpointTime = 0;
  private disposed = false;
  private paused = false;
  // Phase 11 diagnostics: only created when the URL has ?perf=1.
  private perfInstrumentation: SceneInstrumentation | null = null;
  private perfOverlay: HTMLDivElement | null = null;
  private perfFrames = 0;
  private perfLastTime = 0;
  private perfFps = 0;
  private perfDraws = 0;
  private perfTris = 0;

  // Scratch objects reused every frame (no per-frame allocation)
  private readonly _quat = new Quaternion();
  private readonly _rotMatrix = new Matrix();
  private readonly _desiredPos = new Vector3();
  private readonly _desiredTarget = new Vector3();

  constructor(canvas: HTMLCanvasElement, aircraftId?: string) {
    // Multi-aircraft Phase 2: the selection screen's choice,
    // resolved through the registry (unknown ids → the default
    // Cesium Air). Assigned before buildWorld so the model load
    // and the controller both initialize with this aircraft.
    this.aircraftConfig = getAircraftConfig(aircraftId);
    this.engine = new Engine(canvas, true, {
      antialias: true,
      stencil: true,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    // Phase 11: cap the effective render resolution at 2x device
    // pixels. Beyond that the extra fragments buy almost nothing
    // visually on this scene but cost real GPU time on high-DPR
    // laptops/phones.
    const dpr = window.devicePixelRatio || 1;
    if (dpr > 2) this.engine.setHardwareScalingLevel(dpr / 2);

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
    this.freezeStaticWorld();

    this.input = new InputManager();
    // Phase 7: the controller judges ground contact, touchdowns and
    // crashes against the real island/runway ground sampler.
    this.controller = new AircraftController(
      this.aircraft,
      AIRCRAFT_START,
      createGroundSampler(),
      this.obstacleField,
      aircraftVariantById(loadAircraftVariantId()),
      this.aircraftConfig,
    );
    applyCameraConfig(this.aircraftConfig);
    this.input.onGamepadConnectionChange = (connected) =>
      this.onGamepadConnectionChange?.(connected);
    this.applyAircraftPaint(); // placeholder wears the tint until the model lands

    // Development-only debug handle (Phase 4 §6): in `npm run dev`,
    // open the console and use __flightSim.state() / __flightSim.reset()
    if (import.meta.env.DEV) {
      const debugWindow = window as unknown as { __flightSim?: unknown };
      debugWindow.__flightSim = {
        state: () => this.controller.getState(),
        reset: () => this.resetAircraft(),
        controller: this.controller,
        model: () => ({ kind: this.modelKind, id: this.aircraftConfig.id }),
        camera: () => ({ fov: this.camera.fov, mode: this.cameraMode.name }),
      };
    }

    this.camera = new FreeCamera("chase-camera", AIRCRAFT_START.clone(), this.scene);
    this.camera.minZ = 0.1;
    this.camera.maxZ = 8000; // island + sky dome (radius 6300) in view
    this.camera.fov = this.aircraftConfig.camera.fov; // Phase 5: per-aircraft base FOV
    this.resetCamera(); // snap straight to the chase pose, no opening swoop
    this.attachDragLook();

    // Phase 11: opt-in performance overlay (?perf=1) — FPS, draw
    // calls, active meshes/triangles. Zero cost when absent: the
    // instrumentation is only created on request. Used to measure
    // before/after optimization numbers on the live build instead
    // of guessing.
    if (new URLSearchParams(window.location.search).has("perf")) {
      this.perfInstrumentation = new SceneInstrumentation(this.scene);
      this.perfInstrumentation.captureActiveMeshesEvaluationTime = true;
      const el = document.createElement("div");
      el.id = "perf-overlay";
      el.style.cssText =
        "position:fixed;left:10px;bottom:10px;z-index:60;background:rgba(6,16,28,.82);" +
        "color:#cfe8ff;font:12px/1.5 ui-monospace,Menlo,monospace;padding:8px 10px;" +
        "border:1px solid rgba(140,190,255,.4);border-radius:8px;pointer-events:none;white-space:pre;";
      el.textContent = "perf: warming up…";
      document.body.appendChild(el);
      this.perfOverlay = el;
      // Latch the counters AFTER each render: the instrumentation
      // resets them at frame start, so reading them pre-render
      // (the first version did) always showed 0. FPS is counted
      // manually over wall time for the same reason.
      this.perfLastTime = performance.now();
      this.scene.onAfterRenderObservable.add(() => {
        if (!this.perfInstrumentation) return;
        this.perfDraws = this.perfInstrumentation.drawCallsCounter.current;
        this.perfTris = this.scene.getActiveIndices();
        this.perfFrames++;
        const now = performance.now();
        const elapsed = now - this.perfLastTime;
        if (elapsed >= 1000) {
          this.perfFps = (this.perfFrames * 1000) / elapsed;
          this.perfFrames = 0;
          this.perfLastTime = now;
        }
      });
    }

    this.scene.onBeforeRenderObservable.add(() => this.update());

    window.addEventListener("resize", this.onResize);
    this.engine.runRenderLoop(() => {
      if (!this.disposed) this.scene.render();
    });
  }

  /**
   * Phase 11: freeze the world matrices of everything that never
   * moves (terrain, ocean, sky, airport, trees, village) so the
   * engine skips recomputing ~1,500 matrices every frame. The
   * aircraft subtree is excluded (it moves), and checkpoint
   * markers are created later (they pulse), so neither is frozen.
   */
  private freezeStaticWorld(): void {
    for (const mesh of this.scene.meshes) {
      if (mesh === this.aircraft || mesh.isDescendantOf(this.aircraft)) continue;
      mesh.freezeWorldMatrix();
    }
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
    // Clamp frame time so pauses/tab switches can't destabilise physics
    const frameDt = Math.min(this.engine.getDeltaTime() / 1000, MAX_FRAME_DT);

    // Checkpoint guidance pulse (runs even while paused — it is a
    // visual aid, not simulation state).
    this.checkpointTime += frameDt;
    this.checkpointMarkers?.update(this.checkpointTime);

    if (this.paused) {
      this.input.postUpdate();
      return;
    }

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

    // Phase 13: on the crash edge, explode + shake.
    const crashedNow = this.controller.getState().crashed;
    if (crashedNow && !this.wasCrashed) {
      this.spawnExplosion(this.aircraft.position);
      this.shakeTime = 0.7;
    }
    this.wasCrashed = crashedNow;
    if (this.shakeTime > 0) this.shakeTime = Math.max(0, this.shakeTime - frameDt);
    this.updateExplosionFx(frameDt);

    this.updateChaseCamera(frameDt);

    this.telemetryTimer += frameDt;
    if (this.telemetryTimer >= 0.15) {
      this.telemetryTimer = 0;
      this.onTelemetry?.(this.controller.getState());
      if (this.perfOverlay) {
        const engine = this.engine;
        this.perfOverlay.textContent =
          `fps ${this.perfFps.toFixed(0)} · draws ${this.perfDraws}` +
          `\nmeshes ${this.scene.getActiveMeshes().length}/${this.scene.meshes.length}` +
          ` · tris ${(this.perfTris / 1000).toFixed(0)}k` +
          `\nscale ${engine.getHardwareScalingLevel().toFixed(2)} · dpr ${window.devicePixelRatio}` +
          ` · ${engine.getRenderWidth()}×${engine.getRenderHeight()}`;
      }
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

  // ---------- Phase 14: aircraft variants ----------

  getAircraftVariantId(): string {
    return this.controller.getVariant().id;
  }

  isGamepadConnected(): boolean {
    return this.input.gamepadConnected;
  }

  /**
   * Switch edition: new flight profile + paint, persisted, and
   * the aircraft resets (same contract as starting a mission).
   */
  setAircraftVariant(id: string): void {
    const variant = aircraftVariantById(id);
    this.controller.setVariant(variant);
    saveAircraftVariantId(variant.id);
    this.applyAircraftPaint();
    this.resetAircraft();
  }

  /**
   * Apply the active variant's tint to every aircraft material.
   * Originals are captured once, so switching back to Standard
   * restores the exact stock colours.
   */
  private applyAircraftPaint(): void {
    const [tr, tg, tb] = this.controller.getVariant().tint;
    for (const mesh of this.aircraft.getChildMeshes(false)) {
      const mat = mesh.material as unknown as {
        uniqueId: number;
        albedoColor?: Color3;
        diffuseColor?: Color3;
      } | null;
      if (!mat) continue;
      const prop = mat.albedoColor ? "albedoColor" : mat.diffuseColor ? "diffuseColor" : null;
      if (!prop) continue;
      if (!this.paintOriginals.has(mat.uniqueId)) {
        this.paintOriginals.set(mat.uniqueId, mat[prop]!.clone());
      }
      const orig = this.paintOriginals.get(mat.uniqueId)!;
      mat[prop]!.copyFromFloats(orig.r * tr, orig.g * tg, orig.b * tb);
    }
  }

  /**
   * Phase 9: show/hide the checkpoint guidance set for the active
   * mission (rings + route ribbon + next-ring beacon + badges, built
   * by checkpointMarkers.ts). An empty list clears it all (free
   * flight / other missions).
   */
  setCheckpoints(visuals: CheckpointVisual[]): void {
    this.checkpointMarkers?.dispose();
    this.checkpointMarkers =
      visuals.length > 0 ? createCheckpointMarkers(this.scene, visuals) : null;
  }

  /** C: cycle Chase -> Chase far -> Cockpit -> Chase ... */
  /**
   * Phase 5: fire the mode callback with the CURRENT mode. The
   * host calls this right after wiring the callback — a fresh
   * scene starts in Chase, and without the sync the HUD chip
   * kept showing the previous aircraft's last mode.
   */
  reportCameraMode(): void {
    this.onCameraModeChange?.(this.cameraMode.name);
  }

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
    // Phase 12 drag-look: rotate the rig's local offsets by the
    // player's orbit before the aircraft's own rotation. Chase
    // modes rotate position + target together (the camera swings
    // around the aircraft); Cockpit rotates only the look target
    // (a head turn — the eye stays seated).
    const orbit = this.viewYaw !== 0 || this.viewPitch !== 0;
    if (orbit) {
      Quaternion.RotationYawPitchRollToRef(this.viewYaw, this.viewPitch, 0, this._orbitQuat);
    }
    // Offsets rotated into world space (rotation only, no translation)
    if (orbit && mode.name !== "Cockpit") {
      mode.offset.rotateByQuaternionToRef(this._orbitQuat, this._orbitVec);
      Vector3.TransformNormalToRef(this._orbitVec, this._rotMatrix, outPos);
    } else {
      Vector3.TransformNormalToRef(mode.offset, this._rotMatrix, outPos);
    }
    outPos.addInPlace(node.position);
    if (orbit) {
      mode.lookOffset.rotateByQuaternionToRef(this._orbitQuat, this._orbitVec);
      Vector3.TransformNormalToRef(this._orbitVec, this._rotMatrix, outTarget);
    } else {
      Vector3.TransformNormalToRef(mode.lookOffset, this._rotMatrix, outTarget);
    }
    outTarget.addInPlace(node.position);
    // Never let an orbited chase camera sink below the ground it
    // is looking at (a hard pitch drag at low altitude could
    // otherwise put it inside a hillside).
    if (mode.name !== "Cockpit") {
      const groundY = this.cameraSampler(outPos.x, outPos.z).height;
      if (outPos.y < groundY + 1.1) outPos.y = groundY + 1.1;
    }
  }

  private updateChaseCamera(dt: number): void {
    this.computeChasePose(this._desiredPos, this._desiredTarget);
    const mode = this.cameraMode;
    const posAlpha = 1 - Math.exp(-mode.posDamp * dt);
    const targetAlpha = 1 - Math.exp(-mode.targetDamp * dt);
    Vector3.LerpToRef(this.camera.position, this._desiredPos, posAlpha, this.camera.position);
    Vector3.LerpToRef(this.smoothedTarget, this._desiredTarget, targetAlpha, this.smoothedTarget);
    this.camera.setTarget(this.smoothedTarget);
    // Phase 5: speed FOV. The chase modes widen smoothly toward
    // base + boost × (airspeed / maxSpeed) as the aircraft speeds
    // up — the sense of speed is aircraft-specific (a fighter at
    // full chat stretches the view far more than the prop). The
    // cockpit keeps the base FOV. Damped at 2.2/s so it breathes
    // rather than pops, including across mode switches.
    {
      const cam = this.aircraftConfig.camera;
      const speedFrac = clampNum(
        this.controller.getState().airspeed / this.aircraftConfig.maxSpeed,
        0,
        1,
      );
      const targetFov =
        mode.name === "Cockpit" ? cam.fov : cam.fov + cam.fovBoost * speedFrac;
      const fovAlpha = 1 - Math.exp(-2.2 * dt);
      this.camera.fov += (targetFov - this.camera.fov) * fovAlpha;
    }
    if (this.shakeTime > 0) {
      const a = 0.55 * (this.shakeTime / 0.7);
      this.camera.position.x += (Math.random() * 2 - 1) * a;
      this.camera.position.y += (Math.random() * 2 - 1) * a;
      this.camera.position.z += (Math.random() * 2 - 1) * a;
    }
  }

  /** Snap the camera back to the current mode's pose, instantly. */
  resetCamera(): void {
    this.viewYaw = 0;
    this.viewPitch = 0;
    this.computeChasePose(this._desiredPos, this._desiredTarget);
    this.camera.position.copyFrom(this._desiredPos);
    this.smoothedTarget.copyFrom(this._desiredTarget);
    this.camera.setTarget(this.smoothedTarget);
    // Phase 5: a view reset also re-bases the FOV (no leftover
    // speed stretch on the pad).
    this.camera.fov = this.aircraftConfig.camera.fov;
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
    sun.shadowMaxZ = 340;
    (sun as unknown as { orthoLeft: number }).orthoLeft = -200;
    (sun as unknown as { orthoRight: number }).orthoRight = 200;
    (sun as unknown as { orthoTop: number }).orthoTop = 200;
    (sun as unknown as { orthoBottom: number }).orthoBottom = -200;

    const shadows = new ShadowGenerator(2048, sun);
    shadows.useBlurExponentialShadowMap = true;
    shadows.blurKernel = 24;
    shadows.darkness = 0.35;
    return shadows;
  }

  private buildWorld(shadows: ShadowGenerator): TransformNode {
    // Island first: its terrain is flat y=0 across the airport pad,
    // so the airport meshes sit on it exactly as on the old ground.
    const island = createIsland(this.scene);
    const airport = createAirport(this.scene);
    // Phase 13: every solid thing the builders recorded becomes
    // collidable — buildings, tanks, trees, houses, lighthouse.
    this.obstacleField = new ObstacleField([...airport.obstacles, ...island.obstacles]);
    for (const mesh of airport.shadowCasters) shadows.addShadowCaster(mesh);

    // Multi-aircraft Phase 4: the visual comes from the active
    // config — a supplied glTF, a built-in procedural model, or
    // the generic placeholder (see modelSourceFor / ASSETS.md).
    const modelSource = modelSourceFor(this.aircraftConfig);
    if (modelSource.kind === "procedural") {
      // Built synchronously from primitives: nothing streams,
      // so the aircraft is simply there — no hide/reveal dance,
      // no morph. Normalized to the config's length and gear
      // contact exactly like the GLB fit.
      const airplane = new TransformNode("airplane", this.scene);
      const container = new TransformNode("aircraft-model", this.scene);
      container.parent = airplane;
      const inner =
        modelSource.builder === "fighter" ? createFighterJet(this.scene) : createAirplane(this.scene);
      inner.parent = container;
      normalizeProceduralModel(container, airplane, 11 * this.aircraftConfig.scale);
      airplane.position.copyFrom(AIRCRAFT_START);
      airplane.getChildMeshes().forEach((mesh) => {
        mesh.receiveShadows = true;
        shadows.addShadowCaster(mesh);
      });
      this.modelKind = "procedural";
      return airplane;
    }

    const airplane = createAirplane(this.scene);
    airplane.position.copyFrom(AIRCRAFT_START);
    airplane.getChildMeshes().forEach((mesh) => shadows.addShadowCaster(mesh));
    // Phase 8: swap the placeholder for the GLB model when it loads.
    // Async and fully optional — on any failure the placeholder
    // stays and the simulation is unaffected. On success, re-seat
    // the cockpit camera to the model's cabin.
    //
    // The aircraft starts HIDDEN and is revealed exactly once —
    // when the model is in place, or with the placeholder if the
    // load fails / takes too long. (Jeet: seeing one plane morph
    // into another a second after load read as a bug.)
    airplane.setEnabled(false);
    let revealed = false;
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      airplane.setEnabled(true);
    };
    const revealTimer = setTimeout(reveal, 6000);
    void loadAircraftModel(
      this.scene,
      airplane,
      (mesh) => shadows.addShadowCaster(mesh),
      this.aircraftConfig.modelPath,
      this.aircraftConfig.scale,
      this.aircraftConfig.modelYawDeg ?? 0,
    ).then(
      (loaded) => {
        clearTimeout(revealTimer);
        this.modelKind = loaded ? "gltf" : "placeholder";
        if (loaded) this.applyAircraftPaint();
        // The measured COCKPIT_MODEL re-seat belongs to the
        // Cesium Air cabin it was taken from (Phase 8). Other
        // glTF aircraft keep the cockpit pose their config
        // declares — the Cesium offsets would bury the camera
        // inside a 747's upper deck.
        if (loaded && this.aircraftConfig.id === "cesium-air") {
          const cockpit = CAMERA_MODES.find((m) => m.name === "Cockpit");
          if (cockpit) {
            cockpit.offset.copyFrom(COCKPIT_MODEL.offset);
            cockpit.lookOffset.copyFrom(COCKPIT_MODEL.lookOffset);
          }
        }
        reveal();
      },
    );
    return airplane;
  }

  /** Stop the render loop and release all GPU / engine resources. */
  /**
   * Phase 12: click-drag on the canvas orbits the camera (the
   * "grab the view" control other flight games use). Dragging
   * right turns the view right, dragging down looks down; the
   * offsets persist until Reset view / R / a cockpit mode change
   * recentres them. Pointer capture keeps the drag alive outside
   * the canvas, and only the primary button on the canvas itself
   * starts one, so HUD buttons never trigger it.
   */
  private attachDragLook(): void {
    const canvas = this.engine.getRenderingCanvas();
    if (!canvas) return;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || dragging) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.viewYaw = clampNum(this.viewYaw + dx * 0.0052, -2.6, 2.6);
      this.viewPitch = clampNum(this.viewPitch - dy * 0.0042, -0.55, 0.95);
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      canvas.style.cursor = "";
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    this.dragLookDispose = () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
  }

  /**
   * Phase 13: the crash fireball — a burst of additive fire
   * particles, a slower smoke cloud, and a point-light flash, all
   * procedural (a radial-gradient sprite; no assets). чисто visual:
   * any failure here must never affect the simulation, hence the
   * guard. Systems clean themselves up in updateExplosionFx.
   */
  private spawnExplosion(at: Vector3): void {
    try {
      const scene = this.scene;
      const tex = new DynamicTexture("explosion-tex", { width: 64, height: 64 }, scene, false);
      const ctx = tex.getContext();
      const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.4, "rgba(255,255,255,0.55)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 64, 64);
      tex.update();
      tex.hasAlpha = true;

      const fire = new ParticleSystem("explosion-fire", 130, scene);
      fire.particleTexture = tex;
      fire.emitter = at.clone();
      fire.minEmitBox = new Vector3(-1.6, -0.4, -1.6);
      fire.maxEmitBox = new Vector3(1.6, 1.2, 1.6);
      fire.color1 = new Color4(1, 0.6, 0.14, 1);
      fire.color2 = new Color4(0.94, 0.24, 0.04, 1);
      fire.colorDead = new Color4(0.25, 0.03, 0, 0);
      fire.minSize = 1.3;
      fire.maxSize = 3.8;
      fire.minLifeTime = 0.45;
      fire.maxLifeTime = 1.1;
      fire.emitRate = 0;
      fire.manualEmitCount = 120;
      fire.direction1 = new Vector3(-1, 0.1, -1);
      fire.direction2 = new Vector3(1, 1.5, 1);
      fire.minEmitPower = 5;
      fire.maxEmitPower = 13;
      fire.updateSpeed = 0.02;
      fire.blendMode = ParticleSystem.BLENDMODE_ADD;
      fire.start();

      const smoke = new ParticleSystem("explosion-smoke", 60, scene);
      smoke.particleTexture = tex;
      smoke.emitter = at.clone();
      smoke.minEmitBox = new Vector3(-1.2, 0, -1.2);
      smoke.maxEmitBox = new Vector3(1.2, 1.6, 1.2);
      smoke.color1 = new Color4(0.16, 0.16, 0.16, 0.75);
      smoke.color2 = new Color4(0.3, 0.3, 0.3, 0.55);
      smoke.colorDead = new Color4(0.4, 0.4, 0.4, 0);
      smoke.minSize = 2.4;
      smoke.maxSize = 6;
      smoke.minLifeTime = 1.6;
      smoke.maxLifeTime = 2.8;
      smoke.emitRate = 0;
      smoke.manualEmitCount = 46;
      smoke.direction1 = new Vector3(-0.5, 0.8, -0.5);
      smoke.direction2 = new Vector3(0.5, 1.6, 0.5);
      smoke.minEmitPower = 2;
      smoke.maxEmitPower = 5;
      smoke.updateSpeed = 0.016;
      smoke.start();

      const light = new PointLight("explosion-light", at.clone().add(new Vector3(0, 2.5, 0)), scene);
      light.diffuse = new Color3(1, 0.55, 0.2);
      light.intensity = 55;
      light.range = 70;

      this.explosionFx.push({ systems: [fire, smoke], light, ttl: 3 });
    } catch {
      // Visual garnish only — a failed effect must never break a frame.
    }
  }

  private updateExplosionFx(dt: number): void {
    if (this.explosionFx.length === 0) return;
    const keep: typeof this.explosionFx = [];
    for (const fx of this.explosionFx) {
      fx.ttl -= dt;
      if (fx.light) {
        // The flash decays over the first ~0.6 s.
        fx.light.intensity = 55 * Math.max(0, Math.min(1, (fx.ttl - 2.4) / 0.6));
      }
      if (fx.ttl <= 0) {
        for (const s of fx.systems) {
          s.stop();
          s.dispose();
        }
        fx.light?.dispose();
      } else {
        keep.push(fx);
      }
    }
    this.explosionFx = keep;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("resize", this.onResize);
    this.dragLookDispose?.();
    this.dragLookDispose = null;
    for (const fx of this.explosionFx) {
      fx.systems.forEach((s) => s.dispose());
      fx.light?.dispose();
    }
    this.explosionFx = [];
    this.perfInstrumentation?.dispose();
    this.perfInstrumentation = null;
    this.perfOverlay?.remove();
    this.perfOverlay = null;
    this.input.dispose();
    this.checkpointMarkers?.dispose();
    this.checkpointMarkers = null;
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
