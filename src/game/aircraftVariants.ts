/**
 * Phase 14 — aircraft variants.
 *
 * One airframe (the Cesium Air model), three editions. Each
 * variant is a paint tint on the model plus a flight-model
 * profile: thrust / control-rate / drag / top-speed multipliers
 * and a stall-angle shift, applied inside AircraftController.
 * Standard is exactly the pre-Phase-14 tuning (all scales 1), so
 * the existing physics behaviour is the middle variant, not a
 * special case.
 */

export interface AircraftVariant {
  id: string;
  name: string;
  blurb: string;
  /** Flight-model multipliers (1 = standard tuning). */
  thrust: number;
  rates: number;
  drag: number;
  topSpeed: number;
  /** Degrees added to both stall angles (+ = more forgiving). */
  stallShiftDeg: number;
  /** Multiplicative tint on the airframe texture (1,1,1 = stock). */
  tint: [number, number, number];
  /** 1..5 display stats for the picker. */
  stats: { speed: number; agility: number; ease: number };
}

export const AIRCRAFT_VARIANTS: AircraftVariant[] = [
  {
    id: "standard",
    name: "Cesium Air · Standard",
    blurb: "The balanced all-rounder. Stock paint, stock tuning.",
    thrust: 1,
    rates: 1,
    drag: 1,
    topSpeed: 1,
    stallShiftDeg: 0,
    tint: [1, 1, 1],
    stats: { speed: 3, agility: 3, ease: 3 },
  },
  {
    id: "trainer",
    name: "Cesium Air · Trainer",
    blurb: "Gentle power, calm controls, a stall that warns late and bites softly. Learn here.",
    thrust: 0.78,
    rates: 0.8,
    drag: 1.12,
    topSpeed: 0.85,
    stallShiftDeg: 3,
    tint: [1, 0.84, 0.45],
    stats: { speed: 2, agility: 2, ease: 5 },
  },
  {
    id: "sport",
    name: "Cesium Air · Sport",
    blurb: "38% more thrust, sharper controls, less drag — and a stall that arrives earlier. For showing off.",
    thrust: 1.38,
    rates: 1.3,
    drag: 0.88,
    topSpeed: 1.18,
    stallShiftDeg: -2,
    tint: [1, 0.6, 0.44],
    stats: { speed: 5, agility: 5, ease: 2 },
  },
];

export const DEFAULT_VARIANT: AircraftVariant = AIRCRAFT_VARIANTS[0];

export function aircraftVariantById(id: string | null | undefined): AircraftVariant {
  return AIRCRAFT_VARIANTS.find((v) => v.id === id) ?? DEFAULT_VARIANT;
}

const STORAGE_KEY = "flightsim.aircraft.v1";

export function loadAircraftVariantId(): string {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return aircraftVariantById(raw).id;
  } catch {
    return DEFAULT_VARIANT.id;
  }
}

export function saveAircraftVariantId(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, aircraftVariantById(id).id);
  } catch {
    // Storage unavailable (private mode): the choice just won't persist.
  }
}
