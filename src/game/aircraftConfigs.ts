/**
 * Multi-aircraft Phase 1 — the aircraft configuration system.
 *
 * One shared flight model (AircraftController), many aircraft.
 * Every per-aircraft number the physics needs lives in an
 * AircraftConfig; the controller reads them from the active
 * config instead of module constants. Registering a config is
 * all it takes to define a new aircraft — no physics changes.
 *
 * Values are GAMEPLAY values in the physics' own units (newtons,
 * kg, m², rad/s), tuned against this game's world: a 300 m
 * runway, a ~3.2 km island, speeds in m/s. They are not real
 * aircraft specifications — a real airliner's numbers would
 * never lift off from a 300 m strip in this model, so each
 * config was balanced (and is test-verified) to take off, cruise
 * and stall at speeds that feel right for its category.
 *
 * The default aircraft is the existing Cesium Air with EXACTLY
 * the pre-config-system constants, so the game flies byte-for-
 * byte as before until a future phase adds aircraft selection.
 * (The Phase 14 Trainer/Sport editions remain a separate,
 * smaller layer: multipliers applied over whichever config is
 * active.)
 */

export type AircraftCategory = "propeller" | "commercial-jet" | "fighter";

export interface AircraftCameraPose {
  /** Camera position in aircraft space (forward −Z, up +Y). */
  offset: [number, number, number];
  /** Look-target position in aircraft space. */
  lookOffset: [number, number, number];
}

export interface AircraftCameraConfig {
  chase: AircraftCameraPose;
  chaseFar: AircraftCameraPose;
  /** Placeholder-space cockpit eye point; the loaded model may re-seat it (Phase 8). */
  cockpit: AircraftCameraPose;
}

export interface AircraftConfig {
  /** Unique registry id, e.g. "cesium-air". */
  id: string;
  name: string;
  description: string;
  category: AircraftCategory;
  /** Visual identifier the model loader maps to an asset. */
  modelId: string;
  /**
   * Asset path of a real glTF/GLB model, when one is supplied
   * (Phase 4). Takes precedence over proceduralModel. To give an
   * aircraft a real model: drop the file under public/models/,
   * set this path, and — if the automatic fit puts its nose
   * backwards (the fit reads propellers; prop-less models may
   * need it) — set modelYawDeg to 180. See ASSETS.md.
   */
  modelPath?: string;
  /**
   * Built-in procedural model to construct when no glTF is
   * supplied (Phase 4): "airliner" is the primitives-built
   * passenger jet, "fighter" the delta-wing jet. Both are
   * normalized to this config's scale and gear contact.
   */
  proceduralModel?: "airliner" | "fighter";
  /** Extra yaw (degrees) applied to a supplied GLB's fit. */
  modelYawDeg?: number;

  // --- Airframe / engine (physics: force integration) ---
  /** kg. Heavier = statelier acceleration at the same thrust. */
  mass: number;
  /** Newtons at 100% throttle, static, sea level. */
  thrust: number;
  /** Throttle spool multiplier: jets wind up slowly, props bite fast. */
  throttleResponse: number;
  /** Thrust lapse: full thrust until this speed (m/s), then fades… */
  lapseSpeed: number;
  /** …down to this fraction of static thrust. */
  lapseFloor: number;
  /** m/s absolute speed cap (safety net, as before). */
  maxSpeed: number;

  // --- Aerodynamics (physics: lift/drag curves) ---
  wingArea: number; // m²
  liftSlope: number; // lift coefficient per radian of AoA
  clMax: number;
  clMin: number;
  dragParasite: number; // zero-lift drag coefficient
  dragInduced: number; // induced drag factor (× cl²)
  dragStall: number; // extra drag coefficient in the stall
  /**
   * High-speed drag rise ("the wall"): extra drag coefficient
   * ramping in as speed passes dragRiseStart over dragRiseSpan
   * metres/second, up to dragRiseAmount. Props hit their wall
   * early; jets push it far out.
   */
  dragRiseStart: number;
  dragRiseSpan: number;
  dragRiseAmount: number;
  /** AoA (degrees) where the lift break begins, nose-up / nose-down. */
  stallAnglePosDeg: number;
  stallAngleNegDeg: number;
  /**
   * Level-flight stall speed in m/s — kept consistent with
   * mass/wingArea/clMax via analyticStallSpeed() (test-checked);
   * the physics itself stalls on AoA, this is the speed that
   * AoA corresponds to in level flight.
   */
  stallSpeed: number;

  // --- Controls (physics: max surface rates at full deflection) ---
  pitchRate: number; // rad/s
  rollRate: number; // rad/s
  yawRate: number; // rad/s
  /**
   * Control response (1/s): how fast the actual deflections
   * chase the stick — the inertia feel. Low = a heavy aircraft
   * that answers late and gently; high = a fighter's instant
   * bite. (Phase 3: previously one shared value for all.)
   */
  controlResponse: number;

  /** Visual length multiplier applied when the model is fitted (1 = 11 m). */
  scale: number;
  camera: AircraftCameraConfig;
}

const AIR_DENSITY = 1.225; // matches AircraftController
const GRAVITY = 9.81;

/** Level-flight stall speed implied by a config's lift numbers. */
export function analyticStallSpeed(cfg: AircraftConfig): number {
  return Math.sqrt((2 * cfg.mass * GRAVITY) / (AIR_DENSITY * cfg.wingArea * cfg.clMax));
}

// ---------- Registry ----------

const registry = new Map<string, AircraftConfig>();

/**
 * Register an aircraft configuration. This is the extension
 * point: a future aircraft is one registerAircraft() call with
 * a new config object — no other code changes. Throws on a
 * duplicate id so two aircraft can never shadow each other.
 */
export function registerAircraft(cfg: AircraftConfig): void {
  if (!cfg.id || !cfg.name) throw new Error("AircraftConfig needs an id and a name");
  if (registry.has(cfg.id)) throw new Error(`Duplicate aircraft id: ${cfg.id}`);
  registry.set(cfg.id, cfg);
}

/** All registered aircraft, in registration order. */
export function listAircraft(): AircraftConfig[] {
  return [...registry.values()];
}

export const DEFAULT_AIRCRAFT_ID = "cesium-air";

/** Look up by id; unknown ids fall back to the default aircraft. */
export function getAircraftConfig(id: string | null | undefined): AircraftConfig {
  return registry.get(id ?? "") ?? registry.get(DEFAULT_AIRCRAFT_ID)!;
}

// ---------- The fleet ----------

// The existing aircraft, with exactly the constants the flight
// model used before this system existed (AircraftController's
// old MASS/MAX_THRUST/WING_AREA/rates/stall angles, FlightScene's
// camera presets, the model fit's 11 m length). Default forever
// until a selection phase says otherwise.
registerAircraft({
  id: "cesium-air",
  name: "Cesium Air",
  description: "Twin-prop all-rounder — the aircraft this simulator was built around. Forgiving wing, honest controls.",
  category: "propeller",
  modelId: "cesium-air",
  modelPath: "/models/cesium-air.gltf",
  mass: 4600,
  thrust: 21000,
  throttleResponse: 1,
  lapseSpeed: 170,
  lapseFloor: 0.3,
  maxSpeed: 140,
  wingArea: 92,
  liftSlope: 5.7,
  clMax: 1.4,
  clMin: -1.1,
  dragParasite: 0.05,
  dragInduced: 0.05,
  dragStall: 0.3,
  dragRiseStart: 85,
  dragRiseSpan: 35,
  dragRiseAmount: 0.25,
  stallAnglePosDeg: 15,
  stallAngleNegDeg: 12,
  stallSpeed: 24,
  pitchRate: 0.8,
  rollRate: 1.6,
  yawRate: 0.5,
  controlResponse: 7,
  scale: 1,
  camera: {
    chase: { offset: [0, 4.4, 14], lookOffset: [0, 1.1, -8] },
    chaseFar: { offset: [0, 7.5, 27], lookOffset: [0, 1.2, -10] },
    cockpit: { offset: [0, 1.7, -4.8], lookOffset: [0, 1.15, -30] },
  },
});

// Commercial passenger jet. Heavy and spool-slow, with a big
// efficient wing: it uses most of the 300 m runway (as a jet
// should — test F1 keeps it honest: it must lift off from this
// game's one strip), then out-cruises everything. Tuned so
// full-throttle level flight tops out ≈165 m/s — jets keep
// their thrust at speed via a gentler lapse than the prop's.
registerAircraft({
  id: "skyliner-200",
  name: "SkyLiner 200",
  description: "Commercial passenger jet. Heavy, smooth and fast once it winds up — give it runway and time, and it rewards patience.",
  category: "commercial-jet",
  modelId: "skyliner-200",
  proceduralModel: "airliner",
  mass: 19000,
  thrust: 128000,
  throttleResponse: 0.45,
  lapseSpeed: 420,
  lapseFloor: 0.55,
  maxSpeed: 235,
  wingArea: 175,
  liftSlope: 5.4,
  clMax: 1.5,
  clMin: -1.0,
  dragParasite: 0.026,
  dragInduced: 0.055,
  dragStall: 0.3,
  dragRiseStart: 210,
  dragRiseSpan: 60,
  dragRiseAmount: 0.22,
  stallAnglePosDeg: 13,
  stallAngleNegDeg: 10,
  stallSpeed: 34,
  pitchRate: 0.38,
  rollRate: 0.55,
  yawRate: 0.22,
  controlResponse: 3.2,
  scale: 2.6,
  camera: {
    chase: { offset: [0, 8, 30], lookOffset: [0, 2, -16] },
    chaseFar: { offset: [0, 14, 55], lookOffset: [0, 2.5, -20] },
    cockpit: { offset: [0, 3.4, -9.6], lookOffset: [0, 2.3, -60] },
  },
});

// Fighter jet. Light, overpowered and twitchy: instant spool,
// the fastest roll in the fleet, a high-AoA wing — and a cruise
// speed (~195 m/s level) nothing else here can chase.
registerAircraft({
  id: "falcon-f1",
  name: "Falcon F1",
  description: "Fighter jet. Explosive thrust, razor controls, happiest at angles of attack that would terrify the SkyLiner.",
  category: "fighter",
  modelId: "falcon-f1",
  proceduralModel: "fighter",
  mass: 5200,
  thrust: 54000,
  throttleResponse: 1.35,
  lapseSpeed: 380,
  lapseFloor: 0.5,
  maxSpeed: 320,
  wingArea: 46,
  liftSlope: 5.9,
  clMax: 1.6,
  clMin: -1.2,
  dragParasite: 0.024,
  dragInduced: 0.04,
  dragStall: 0.3,
  dragRiseStart: 260,
  dragRiseSpan: 70,
  dragRiseAmount: 0.2,
  stallAnglePosDeg: 19,
  stallAngleNegDeg: 15,
  stallSpeed: 34,
  pitchRate: 1.5,
  rollRate: 3.4,
  yawRate: 0.7,
  controlResponse: 11,
  scale: 1.35,
  camera: {
    chase: { offset: [0, 3.6, 12], lookOffset: [0, 0.9, -8] },
    chaseFar: { offset: [0, 6.5, 24], lookOffset: [0, 1.1, -10] },
    cockpit: { offset: [0, 1.9, -5.4], lookOffset: [0, 1.3, -30] },
  },
});

export const DEFAULT_AIRCRAFT_CONFIG: AircraftConfig = getAircraftConfig(DEFAULT_AIRCRAFT_ID);

/** Human-readable category labels for UI (selection cards). */
export const AIRCRAFT_CATEGORY_LABELS: Record<AircraftCategory, string> = {
  propeller: "Propeller",
  "commercial-jet": "Commercial Jet",
  fighter: "Fighter Jet",
};

// ---------- Selection persistence (Phase 2) ----------
// The selection screen remembers the last aircraft flown, the
// same way the Phase 14 edition and the audio prefs persist.

const CHOICE_KEY = "flightsim.aircraftChoice.v1";

/** The persisted aircraft id, validated against the registry. */
export function loadAircraftChoiceId(): string {
  try {
    const raw = window.localStorage.getItem(CHOICE_KEY);
    if (raw && registry.has(raw)) return raw;
  } catch {
    /* storage unavailable — default */
  }
  return DEFAULT_AIRCRAFT_ID;
}

export function saveAircraftChoiceId(id: string): void {
  try {
    window.localStorage.setItem(CHOICE_KEY, id);
  } catch {
    /* storage unavailable — selection just won't persist */
  }
}
