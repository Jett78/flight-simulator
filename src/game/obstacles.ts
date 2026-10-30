/**
 * Phase 13 — solid obstacles: buildings, tanks, trees.
 *
 * The world builders (createAirport / createIsland) record a
 * simple volume for everything solid while they build the visual
 * meshes. An ObstacleField indexes those volumes on a coarse
 * spatial grid so the flight model can ask, per physics step,
 * "is the aircraft inside anything?" — cheaply, even with
 * ~1,000+ trees on the island.
 *
 * Collision semantics (AircraftController): the aircraft is a
 * sphere of AIRCRAFT_RADIUS around its origin. A hit above
 * OBSTACLE_CRASH_SPEED crashes; a slow hit just pushes the
 * aircraft back out (the object is solid — you can bump a hangar
 * while taxiing, you cannot drive through it).
 */

export const AIRCRAFT_RADIUS = 4;
export const OBSTACLE_CRASH_SPEED = 10; // m/s (~36 km/h)

export interface ObstacleBox {
  kind: "box";
  /** Mesh-ish name, mapped to a friendly label for crash text. */
  name: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  baseY: number;
  topY: number;
}

export interface ObstacleCylinder {
  kind: "cylinder";
  name: string;
  x: number;
  z: number;
  radius: number;
  baseY: number;
  topY: number;
}

export type Obstacle = ObstacleBox | ObstacleCylinder;

export interface ObstacleHit {
  name: string;
  /** Friendly label for the crash reason, e.g. "a hangar". */
  label: string;
  /** Push-out direction (unit, horizontal) and depth in metres. */
  pushX: number;
  pushZ: number;
  depth: number;
}

export function obstacleLabel(name: string): string {
  if (name.startsWith("hangar")) return "a hangar";
  if (name.startsWith("tree") || name.startsWith("island-tree")) return "a tree";
  if (name.startsWith("terminal-2")) return "Terminal 2";
  if (name.startsWith("terminal")) return "the terminal";
  if (name.startsWith("cargo")) return "the cargo terminal";
  if (name.startsWith("container")) return "a freight container";
  if (name.startsWith("fire")) return "the fire station";
  if (name.startsWith("fuel-tank")) return "a fuel tank";
  if (name.startsWith("fuel")) return "the fuel depot";
  if (name.startsWith("radar")) return "the radar tower";
  if (name.startsWith("tower")) return "the control tower";
  if (name.startsWith("office")) return "the office block";
  if (name.startsWith("house")) return "a village house";
  if (name.startsWith("lighthouse")) return "the lighthouse";
  return "a building";
}

const CELL = 64;

export class ObstacleField {
  private readonly grid = new Map<string, Obstacle[]>();
  readonly count: number;

  constructor(obstacles: Obstacle[]) {
    this.count = obstacles.length;
    for (const o of obstacles) {
      const [minX, maxX, minZ, maxZ] =
        o.kind === "box"
          ? [o.minX, o.maxX, o.minZ, o.maxZ]
          : [o.x - o.radius, o.x + o.radius, o.z - o.radius, o.z + o.radius];
      const cx0 = Math.floor((minX - AIRCRAFT_RADIUS) / CELL);
      const cx1 = Math.floor((maxX + AIRCRAFT_RADIUS) / CELL);
      const cz0 = Math.floor((minZ - AIRCRAFT_RADIUS) / CELL);
      const cz1 = Math.floor((maxZ + AIRCRAFT_RADIUS) / CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const key = `${cx}:${cz}`;
          let cell = this.grid.get(key);
          if (!cell) {
            cell = [];
            this.grid.set(key, cell);
          }
          cell.push(o);
        }
      }
    }
  }

  /**
   * Deepest penetration of a sphere at (x, y, z) with radius r
   * into any obstacle, or null. Push-out is horizontal (obstacles
   * are vertical extrusions) and points away from the obstacle.
   */
  query(x: number, y: number, z: number, r: number): ObstacleHit | null {
    const cell = this.grid.get(`${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`);
    if (!cell) return null;
    let best: ObstacleHit | null = null;
    for (const o of cell) {
      if (y - r >= o.topY || y + r <= o.baseY) continue;
      if (o.kind === "box") {
        // Sphere (projected to a circle) vs box, expanded by r.
        const dx = x < o.minX ? o.minX - x : x > o.maxX ? x - o.maxX : 0;
        const dz = z < o.minZ ? o.minZ - z : z > o.maxZ ? z - o.maxZ : 0;
        if (dx === 0 && dz === 0) {
          // Centre inside the box: push out along the shallowest face.
          const left = x - o.minX + r;
          const right = o.maxX - x + r;
          const near = z - o.minZ + r;
          const far = o.maxZ - z + r;
          const m = Math.min(left, right, near, far);
          const hit: ObstacleHit =
            m === left
              ? { name: o.name, label: obstacleLabel(o.name), pushX: -1, pushZ: 0, depth: left }
              : m === right
                ? { name: o.name, label: obstacleLabel(o.name), pushX: 1, pushZ: 0, depth: right }
                : m === near
                  ? { name: o.name, label: obstacleLabel(o.name), pushX: 0, pushZ: -1, depth: near }
                  : { name: o.name, label: obstacleLabel(o.name), pushX: 0, pushZ: 1, depth: far };
          if (!best || hit.depth > best.depth) best = hit;
        } else {
          const dist = Math.hypot(dx, dz);
          if (dist < r) {
            const inv = dist > 0.0001 ? 1 / dist : 0;
            const hit: ObstacleHit = {
              name: o.name,
              label: obstacleLabel(o.name),
              pushX: -dx * inv,
              pushZ: -dz * inv,
              depth: r - dist,
            };
            if (!best || hit.depth > best.depth) best = hit;
          }
        }
      } else {
        const dx = x - o.x;
        const dz = z - o.z;
        const dist = Math.hypot(dx, dz);
        const rr = o.radius + r * 0.6; // trees are slim: shrink the aircraft radius too
        if (dist < rr) {
          const inv = dist > 0.0001 ? 1 / dist : 1;
          const hit: ObstacleHit = {
            name: o.name,
            label: obstacleLabel(o.name),
            pushX: dx * inv,
            pushZ: dz * inv,
            depth: rr - dist,
          };
          if (!best || hit.depth > best.depth) best = hit;
        }
      }
    }
    return best;
  }
}
