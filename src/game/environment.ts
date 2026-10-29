import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Scene } from "@babylonjs/core/scene";

/**
 * Phase 10 — lightweight environment: clouds, fog and weather.
 *
 * Weather presets adjust fog density/colour and sky colour.
 * (Phase 10 originally also added a cloud layer; Jeet asked for
 * the clouds to be removed the same day, so weather is fog + sky
 * only.) Wind remains environmental colour in the audio only; the
 * flight model is untouched, so airspeed keeps its existing
 * meaning and weather can never break the physics.
 */

export type WeatherId = "clear" | "cloudy" | "storm";

export interface WeatherPreset {
  id: WeatherId;
  name: string;
  icon: string;
  fogDensity: number;
  fogColor: [number, number, number];
  skyColor: [number, number, number];
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
  },
  cloudy: {
    id: "cloudy",
    name: "Cloudy",
    icon: "☁",
    fogDensity: 0.00055,
    fogColor: [0.62, 0.7, 0.82],
    skyColor: [0.45, 0.6, 0.82],
  },
  storm: {
    id: "storm",
    name: "Storm",
    icon: "⛈",
    fogDensity: 0.00095,
    fogColor: [0.45, 0.52, 0.62],
    skyColor: [0.32, 0.42, 0.58],
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


/** Apply a weather preset to a scene (fog + sky). Returns the preset. */
export function applyWeatherToScene(scene: Scene, id: WeatherId): WeatherPreset {
  const preset = WEATHER_PRESETS[id];
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = preset.fogDensity;
  scene.fogColor = new Color3(...preset.fogColor);
  scene.clearColor = new Color4(...preset.skyColor, 1);
  return preset;
}
