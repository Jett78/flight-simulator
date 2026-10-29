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
  // x, ring-centre height (world Y), z — a circuit around the island
  [0, 95, -520], // climb out to the north
  [430, 115, -380], // right turn, east side
  [520, 100, 180], // southbound along the coast
  [180, 85, 560], // turning for home
  [-260, 80, 300], // final gate, west side
];
const CP_RADIUS = 30;

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
    blurb: "Fly through all 5 rings in order, as fast as you can.",
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
    if (this.id !== "checkpoints" || this.status !== "active") return null;
    const cp = CHECKPOINTS[this.nextIndex];
    if (!cp) return null;
    const wy = state.altitude + 2.41; // aircraft root world Y
    return Math.hypot(state.posX - cp.x, wy - cp.y, state.posZ - cp.z);
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
  return CHECKPOINTS.map((cp, i) => ({ ...cp, active: i === run.nextIndex }));
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
    return typeof parsed === "object" && parsed ? parsed : {};
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
