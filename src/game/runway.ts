import type { GroundInfo, GroundSampler } from "./AircraftController";
import { SEA_LEVEL, terrainMeshHeightAt } from "./createIsland";

/**
 * Runway geometry — the single source of truth (Phase 7).
 *
 * Matches the visual runway built in createAirport.ts: an 18 m wide,
 * 300 m long asphalt box centred on the origin, top surface at
 * y = 0.16, long axis along Z (takeoff/landing heading is -Z, the
 * aircraft's start direction). Anything that needs to know "where is
 * the runway" reads it from here instead of hard-coding coordinates.
 */
export const RUNWAY = {
  /** Half-width (m): the asphalt spans x in [-9, 9]. */
  halfWidth: 9,
  /** Half-length (m): the asphalt spans z in [-150, 150]. */
  halfLength: 150,
  /** Height of the asphalt surface above the terrain pad. */
  surfaceY: 0.16,
  centerX: 0,
  centerZ: 0,
} as const;

/**
 * Concrete/asphalt slabs beyond the runway (v0.24.0): their tops
 * sit at y = 0.12 while the island terrain pad is y = 0, so a
 * sampler that only knows the runway rect sinks wheels 12 cm
 * into the slabs and applies rough-ground friction there. Rects
 * match the boxes built in createAirport.ts.
 */
const SLABS = [
  { xMin: -51, xMax: -9, zMin: 25.5, zMax: 34.5 }, // taxiway
  { xMin: -89, xMax: -51, zMin: 7, zMax: 53 }, // apron
  { xMin: 35, xMax: 81, zMin: 76, zMax: 112 }, // remote stand
  { xMin: 8, xMax: 35, zMin: 90, zMax: 98 }, // stand taxi link
] as const;

/** Slab top height (m): 0.12 m boxes centred at y = 0.06. */
const SLAB_SURFACE_Y = 0.12;

/** Is this world position over the asphalt (optionally shrunk/grown)? */
export function isOverRunway(x: number, z: number, margin = 0): boolean {
  return (
    Math.abs(x - RUNWAY.centerX) <= RUNWAY.halfWidth - margin &&
    Math.abs(z - RUNWAY.centerZ) <= RUNWAY.halfLength - margin
  );
}

/**
 * The real ground sampler for the island world: runway rectangle
 * first, then the concrete/asphalt slabs, then the island's
 * rendered terrain height, with the sea surface wherever the
 * terrain drops below sea level. Slope is a finite difference
 * of the terrain height (the runway and slabs are flat).
 *
 * FlightScene hands this to the AircraftController, which stays
 * decoupled from the island/runway modules.
 */
export function createGroundSampler(): GroundSampler {
  return (x: number, z: number): GroundInfo => {
    if (isOverRunway(x, z)) {
      return { height: RUNWAY.surfaceY, surface: "runway", slopeDeg: 0, gradeX: 0, gradeZ: 0, onRunway: true };
    }
    if (SLABS.some((s) => x >= s.xMin && x <= s.xMax && z >= s.zMin && z <= s.zMax)) {
      return { height: SLAB_SURFACE_Y, surface: "runway", slopeDeg: 0, gradeX: 0, gradeZ: 0, onRunway: false };
    }
    // The RENDERED mesh surface, not the analytic heightfield —
    // otherwise the aircraft floats/sinks against the visible
    // ground on slopes, exactly like the trees did.
    const h = terrainMeshHeightAt(x, z);
    if (h <= SEA_LEVEL) {
      return { height: SEA_LEVEL, surface: "water", slopeDeg: 0, gradeX: 0, gradeZ: 0, onRunway: false };
    }
    const d = 3;
    const gradeX = (terrainMeshHeightAt(x + d, z) - terrainMeshHeightAt(x - d, z)) / (2 * d);
    const gradeZ = (terrainMeshHeightAt(x, z + d) - terrainMeshHeightAt(x, z - d)) / (2 * d);
    const slopeDeg = (Math.atan(Math.hypot(gradeX, gradeZ)) * 180) / Math.PI;
    return { height: h, surface: "terrain", slopeDeg, gradeX, gradeZ, onRunway: false };
  };
}
