import type { FlightState } from "./AircraftController";

/**
 * Phase 9 — mission system (pure logic, no rendering, no physics).
 *
 * A MissionRun consumes the same FlightState the HUD already reads
 * and decides progress, completion and failure. It never touches
 * the controller: the landing challenge in particular is judged by
 * the Phase 7 touchdown verdict carried in FlightState — there is
 * no second landing system.
 *
 * Scoring rules (also in the README — keep the two in sync):
 *   Checkpoint flight : score = max(100, 1500 − 10 × elapsed s)
 *   Takeoff & climb   : score = max(100, 1000 − 10 × elapsed s)
 *   Landing challenge : base 1000 (smooth) / 600 (hard touchdown),
 *                       minus 5 × elapsed s, floored at 100.
 *   Any failure (crash, off-runway landing) scores 0 and never
 *   counts as a completion. Completion is only ever awarded when
 *   the underlying condition has actually been met.
 */

export type MissionId = "checkpoints" | "takeoff" | "landing";
export type RunStatus = "active" | "complete" | "failed";

export interface CheckpointDef {
  x: number;
  /** World-space height of the ring centre (aircraft root Y). */
  y: number;
  z: number;
  r: number;
  /** Ring facing (radians about Y), aligned to the route segment. */
  yaw: number;
}

export const TAKEOFF_TARGET_ALTITUDE = 120; // metres above the runway datum

const CP_POINTS: [number, number, number][] = [
  // x, ring-centre height (world Y), z — a circuit around the island.
  // 0.9.1: the course was re-plotted for playability. Every ring now
  // keeps at least ~28 m of clearance over the terrain within 50 m
  // horizontally (checked against the island heightfield) — the old
  // ring 2 sat at a mountain peak and its rim intersected the slope.
  // The legs are also shorter and the first climb is gentler.
  [0, 65, -360], // climb out to the north
  [260, 110, -540], // right turn, north-east hills
  [560, 100, -40], // east coast, turning south
  [300, 90, 520], // south shore, turning for home
  [-160, 85, 300], // final gate, south-west
];
const CP_RADIUS = 42;

export const CHECKPOINTS: CheckpointDef[] = CP_POINTS.map(([x, y, z], i) => {
  const prev = i === 0 ? [0, 68] : [CP_POINTS[i - 1][0], CP_POINTS[i - 1][2]];
  return { x, y, z, r: CP_RADIUS, yaw: Math.atan2(x - prev[0], z - prev[1]) };
});

export const MISSION_INFO: Record<
  MissionId,
  { name: string; blurb: string }
> = {
  checkpoints: {
    name: "Checkpoint Flight",
    blurb: "Follow the gold beacon, route line and map through all 5 rings, in order.",
  },
  takeoff: {
    name: "Takeoff & Climb",
    blurb: `Take off and climb to ${TAKEOFF_TARGET_ALTITUDE} m.`,
  },
  landing: {
    name: "Landing Challenge",
    blurb: "Take off, come back, and land on the runway. Smooth pays more.",
  },
};

export interface CheckpointVisual extends CheckpointDef {
  active: boolean;
  state: "completed" | "active" | "upcoming";
}

/** Live guidance to the next checkpoint, for the HUD arrow/map. */
export interface CheckpointNavigation {
  index: number;
  target: CheckpointDef;
  /** 3D distance to the ring centre, metres. */
  distance: number;
  /** Compass bearing to the target, degrees (0 = north / -Z). */
  bearingDeg: number;
  /** Signed turn from the current heading: - = left, + = right. */
  relativeBearingDeg: number;
  /** Target height minus aircraft height: + = climb, - = descend. */
  altitudeDelta: number;
  direction: "straight" | "left" | "right" | "around";
}

export function checkpointNavigation(
  state: FlightState,
  index: number,
): CheckpointNavigation | null {
  const target = CHECKPOINTS[index];
  if (!target) return null;
  const wy = state.altitude + 2.41; // aircraft root world Y
  const dx = target.x - state.posX;
  const dz = target.z - state.posZ;
  const distance = Math.hypot(dx, target.y - wy, dz);
  const bearingDeg = (Math.atan2(dx, -dz) * (180 / Math.PI) + 360) % 360;
  const relativeBearingDeg =
    ((bearingDeg - state.headingDeg + 540) % 360) - 180;
  const direction =
    Math.abs(relativeBearingDeg) <= 10
      ? "straight"
      : Math.abs(relativeBearingDeg) >= 170
        ? "around"
        : relativeBearingDeg < 0
          ? "left"
          : "right";
  return {
    index,
    target,
    distance,
    bearingDeg,
    relativeBearingDeg,
    altitudeDelta: target.y - wy,
    direction,
  };
}

export class MissionRun {
  readonly id: MissionId;
  status: RunStatus = "active";
  failReason = "";
  elapsed = 0;
  /** Next checkpoint index (checkpoints mission). */
  nextIndex = 0;
  /** Landing quality once the landing challenge completes. */
  landingQuality: "smooth" | "hard" | null = null;
  score = 0;

  private wasAirborne = false;
  private touchdownSeqSeen = 0;

  constructor(id: MissionId, initialTouchdownSeq = 0) {
    this.id = id;
    this.touchdownSeqSeen = initialTouchdownSeq;
  }

  /** Distance to the next checkpoint centre, metres (checkpoints only). */
  distanceToNext(state: FlightState): number | null {
    return this.navigationToNext(state)?.distance ?? null;
  }

  /** Full navigation guidance to the next checkpoint (checkpoints only). */
  navigationToNext(state: FlightState): CheckpointNavigation | null {
    if (this.id !== "checkpoints" || this.status !== "active") return null;
    return checkpointNavigation(state, this.nextIndex);
  }

  /** Advance the mission. dtSeconds is real elapsed time (already
   *  zeroed by the caller while paused). Call once per frame. */
  step(state: FlightState, dtSeconds: number): void {
    if (this.status !== "active") return;
    this.elapsed += Math.max(0, dtSeconds);

    if (state.crashed) return this.fail("Crashed — " + (state.crashReason || "aircraft destroyed"));
    if (state.phase === "air") this.wasAirborne = true;

    switch (this.id) {
      case "checkpoints": {
        const cp = CHECKPOINTS[this.nextIndex];
        if (!cp) return this.complete();
        if (this.distanceToNext(state)! <= cp.r) {
          this.nextIndex++;
          if (this.nextIndex >= CHECKPOINTS.length) this.complete();
        }
        break;
      }
      case "takeoff": {
        if (this.wasAirborne && state.altitude >= TAKEOFF_TARGET_ALTITUDE) this.complete();
        break;
      }
      case "landing": {
        const td = state.touchdown;
        if (this.wasAirborne && td && td.sequence !== this.touchdownSeqSeen) {
          this.touchdownSeqSeen = td.sequence;
          if (td.surface === "runway" && (td.quality === "smooth" || td.quality === "hard")) {
            this.landingQuality = td.quality;
            this.complete();
          } else if (td.surface !== "runway") {
            this.fail("Landed off the runway");
          }
        }
        break;
      }
    }
  }

  private complete(): void {
    this.status = "complete";
    const t = this.elapsed;
    switch (this.id) {
      case "checkpoints":
        this.score = Math.max(100, Math.round(1500 - 10 * t));
        break;
      case "takeoff":
        this.score = Math.max(100, Math.round(1000 - 10 * t));
        break;
      case "landing":
        this.score = Math.max(
          100,
          Math.round((this.landingQuality === "smooth" ? 1000 : 600) - 5 * t),
        );
        break;
    }
  }

  private fail(reason: string): void {
    this.status = "failed";
    this.failReason = reason;
    this.score = 0;
  }
}

/** Visual state for the 3D rings (empty unless a checkpoint run is live). */
export function checkpointVisuals(run: MissionRun | null): CheckpointVisual[] {
  if (!run || run.id !== "checkpoints" || run.status !== "active") return [];
  return CHECKPOINTS.map((cp, i) => ({
    ...cp,
    active: i === run.nextIndex,
    state: i < run.nextIndex ? "completed" : i === run.nextIndex ? "active" : "upcoming",
  }));
}

// ---------- Local records (best scores; localStorage only) ----------

export interface MissionRecord {
  best: number;
  completions: number;
  plays: number;
}
export type MissionRecords = Partial<Record<MissionId, MissionRecord>>;

const RECORDS_KEY = "flightsim.missions.v1";

export function loadRecords(): MissionRecords {
  try {
    const raw = localStorage.getItem(RECORDS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as MissionRecords;
    if (typeof parsed !== "object" || !parsed) return {};
    // Sanitize entry by entry (Phase 11 reliability): a hand-edited
    // or partially corrupt save must not poison the best-score
    // table with NaN/negative/string values.
    const clean: MissionRecords = {};
    for (const [id, rec] of Object.entries(parsed)) {
      const num = (v: unknown) =>
        typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
      if (rec && typeof rec === "object") {
        clean[id as MissionId] = {
          best: num(rec.best),
          completions: num(rec.completions),
          plays: num(rec.plays),
        };
      }
    }
    return clean;
  } catch {
    return {};
  }
}

export function recordStart(records: MissionRecords, id: MissionId): MissionRecords {
  const next = { ...records };
  const cur = next[id] ?? { best: 0, completions: 0, plays: 0 };
  next[id] = { ...cur, plays: cur.plays + 1 };
  persist(next);
  return next;
}

export function recordCompletion(records: MissionRecords, id: MissionId, score: number): MissionRecords {
  const next = { ...records };
  const cur = next[id] ?? { best: 0, completions: 0, plays: 0 };
  next[id] = {
    ...cur,
    completions: cur.completions + 1,
    best: Math.max(cur.best, score),
  };
  persist(next);
  return next;
}

function persist(records: MissionRecords): void {
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
  } catch {
    // Storage unavailable (private mode etc.) — records are optional.
  }
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
