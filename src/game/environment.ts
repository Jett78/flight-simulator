import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Scene } from "@babylonjs/core/scene";

/**
 * Phase 10 — lightweight environment: clouds, fog and weather.
 *
 * Clouds are 36 billboard planes sharing one canvas-drawn soft-blob
 * texture and one material — no particles, no post-processing, no
 * extra lights. Weather presets adjust fog density/colour, sky
 * colour, cloud coverage/tint and the cloud drift (wind). Wind here
 * is ENVIRONMENTAL ONLY: it moves clouds and flavours the wind
 * audio; the flight model is untouched, so airspeed keeps its
 * existing meaning and weather can never break the physics.
 */

export type WeatherId = "clear" | "cloudy" | "storm";

export interface WeatherPreset {
  id: WeatherId;
  name: string;
  icon: string;
  fogDensity: number;
  fogColor: [number, number, number];
  skyColor: [number, number, number];
  /** Fraction of the cloud set visible, 0..1. */
  cloudFraction: number;
  cloudAlpha: number;
  cloudTint: [number, number, number];
  /** Cloud drift, m/s in world X/Z. */
  wind: { x: number; z: number };
}

export const WEATHER_ORDER: WeatherId[] = ["clear", "cloudy", "storm"];

export const WEATHER_PRESETS: Record<WeatherId, WeatherPreset> = {
  clear: {
    id: "clear",
    name: "Clear",
    icon: "☀",
    fogDensity: 0.0003,
    fogColor: [0.66, 0.8, 0.94],
    skyColor: [0.47, 0.71, 0.96],
    cloudFraction: 0.25,
    cloudAlpha: 0.5,
    cloudTint: [1, 1, 1],
    wind: { x: 1.6, z: 0.6 },
  },
  cloudy: {
    id: "cloudy",
    name: "Cloudy",
    icon: "☁",
    fogDensity: 0.00055,
    fogColor: [0.62, 0.7, 0.82],
    skyColor: [0.45, 0.6, 0.82],
    cloudFraction: 0.7,
    cloudAlpha: 0.78,
    cloudTint: [0.92, 0.94, 0.98],
    wind: { x: 4.5, z: 1.8 },
  },
  storm: {
    id: "storm",
    name: "Storm",
    icon: "⛈",
    fogDensity: 0.00095,
    fogColor: [0.45, 0.52, 0.62],
    skyColor: [0.32, 0.42, 0.58],
    cloudFraction: 1,
    cloudAlpha: 0.92,
    cloudTint: [0.62, 0.66, 0.74],
    wind: { x: 9, z: 3.5 },
  },
};

const PREF_KEY = "flightsim.weather.v1";

export function loadWeatherPref(): WeatherId {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw === "cloudy" || raw === "storm" ? raw : "clear";
  } catch {
    return "clear";
  }
}

export function saveWeatherPref(id: WeatherId): void {
  try {
    localStorage.setItem(PREF_KEY, id);
  } catch {
    // Optional — ignore storage failures.
  }
}

// --- Clouds ---------------------------------------------------------------

const CLOUD_COUNT = 36;
const DRIFT_BOUND = 2000;

/** Deterministic seeded RNG so the sky is identical on every load. */
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

function makeCloudTexture(scene: Scene): DynamicTexture | null {
  try {
    const tex = new DynamicTexture("cloud-blob", { width: 256, height: 128 }, scene, true);
    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 256, 128);
    // A cluster of soft radial blobs reads as one puffy cloud.
    const blobs: [number, number, number][] = [
      [128, 70, 52],
      [86, 78, 38],
      [170, 78, 40],
      [110, 58, 34],
      [148, 60, 36],
      [64, 84, 26],
      [192, 84, 28],
    ];
    for (const [x, y, r] of blobs) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(255,255,255,0.55)");
      g.addColorStop(0.6, "rgba(255,255,255,0.28)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    tex.hasAlpha = true;
    tex.update();
    return tex;
  } catch {
    return null;
  }
}

export interface EnvironmentHandle {
  setWeather: (id: WeatherId) => WeatherPreset;
  update: (dtSeconds: number) => void;
  dispose: () => void;
  readonly cloudCount: number;
  visibleCloudCount: () => number;
  currentWeather: () => WeatherId;
}

export function createEnvironment(scene: Scene): EnvironmentHandle {
  const rng = mulberry32(20261029);
  const texture = makeCloudTexture(scene);
  const material = new StandardMaterial("cloud-mat", scene);
  if (texture) {
    material.diffuseTexture = texture;
    material.emissiveTexture = texture;
  }
  material.emissiveColor = new Color3(1, 1, 1);
  material.diffuseColor = new Color3(1, 1, 1);
  material.transparencyMode = 2; // alpha blend
  material.alpha = 0.5;
  material.backFaceCulling = false;
  material.disableLighting = false;

  const clouds: AbstractMesh[] = [];
  // Shuffled visibility ranks so each weather's visible subset is
  // scattered across the sky rather than clustered on one side.
  const ranks = Array.from({ length: CLOUD_COUNT }, (_, i) => i);
  for (let i = ranks.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [ranks[i], ranks[j]] = [ranks[j], ranks[i]];
  }
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const angle = rng() * Math.PI * 2;
    const radius = 260 + Math.sqrt(rng()) * 1500;
    const width = 150 + rng() * 210;
    const cloud = MeshBuilder.CreatePlane(
      `cloud-${i}`,
      { width, height: width * 0.44 },
      scene,
    );
    cloud.position.set(
      Math.cos(angle) * radius,
      195 + rng() * 150,
      Math.sin(angle) * radius,
    );
    cloud.billboardMode = AbstractMesh.BILLBOARDMODE_ALL;
    cloud.material = material;
    cloud.isPickable = false;
    cloud.metadata = { rank: ranks[i] };
    clouds.push(cloud);
  }

  let weather: WeatherPreset = WEATHER_PRESETS.clear;

  const applyVisibility = () => {
    const visible = Math.round(weather.cloudFraction * CLOUD_COUNT);
    for (const cloud of clouds) {
      cloud.isVisible = (cloud.metadata as { rank: number }).rank < visible;
    }
  };

  return {
    cloudCount: CLOUD_COUNT,
    currentWeather: () => weather.id,
    visibleCloudCount: () => clouds.filter((c) => c.isVisible).length,
    setWeather(id: WeatherId): WeatherPreset {
      weather = WEATHER_PRESETS[id];
      scene.fogDensity = weather.fogDensity;
      scene.fogColor = new Color3(...weather.fogColor);
      scene.clearColor = new Color4(...weather.skyColor, 1);
      material.alpha = weather.cloudAlpha;
      material.emissiveColor = new Color3(...weather.cloudTint);
      material.diffuseColor = new Color3(...weather.cloudTint);
      applyVisibility();
      return weather;
    },
    update(dtSeconds: number): void {
      const dx = weather.wind.x * dtSeconds;
      const dz = weather.wind.z * dtSeconds;
      for (const cloud of clouds) {
        cloud.position.x += dx;
        cloud.position.z += dz;
        if (cloud.position.x > DRIFT_BOUND) cloud.position.x = -DRIFT_BOUND;
        if (cloud.position.z > DRIFT_BOUND) cloud.position.z = -DRIFT_BOUND;
      }
    },
    dispose(): void {
      for (const cloud of clouds) cloud.dispose();
      material.dispose();
      texture?.dispose();
      clouds.length = 0;
    },
  };
}
