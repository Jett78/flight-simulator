import { useEffect } from "react";
import {
  listAircraft,
  AIRCRAFT_CATEGORY_LABELS,
  type AircraftConfig,
} from "../game/aircraftConfigs";
import { AIRCRAFT_PREVIEW_IMAGES } from "./aircraftPreviews";
import "./AircraftSelect.css";

/**
 * The pre-flight aircraft selection screen. Shown before a
 * flight starts; the chosen config is handed to FlightScene at
 * construction, so the whole game (physics, camera, model fit)
 * initializes with it — this is the game's start screen, not a
 * HUD name tag.
 *
 * Card photos are screenshots of the exact aircraft models as
 * they appear in gameplay (Jeet, v0.21.0: "use exact image as
 * in gameplay, no others") — captured in-engine at the spawn
 * point, no stock art, no drawn silhouettes.
 */

const AIRCRAFT_PREVIEWS = AIRCRAFT_PREVIEW_IMAGES;

const kmh = (ms: number) => Math.round(ms * 3.6);
const kn = (n: number) => Math.round(n / 1000);

function AircraftCard({
  cfg,
  selected,
  onSelect,
  onFly,
}: {
  cfg: AircraftConfig;
  selected: boolean;
  onSelect: () => void;
  onFly: () => void;
}) {
  return (
    <button
      type="button"
      className={`select-card${selected ? " is-selected" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
      onDoubleClick={onFly}
    >
      <div className="select-photo">
        <img
          src={AIRCRAFT_PREVIEWS[cfg.id] ?? AIRCRAFT_PREVIEWS["cesium-air"]}
          alt={`${cfg.name} in the simulator`}
          draggable={false}
        />
        <span className="select-chip">{AIRCRAFT_CATEGORY_LABELS[cfg.category]}</span>
        {selected && <span className="select-selected">✓ Selected</span>}
        <h2>{cfg.name}</h2>
      </div>
      <p className="select-desc">{cfg.description}</p>
      <dl className="select-stats">
        <div>
          <dt>Max speed</dt>
          <dd>{kmh(cfg.maxSpeed)} km/h</dd>
        </div>
        <div>
          <dt>Thrust</dt>
          <dd>{kn(cfg.thrust)} kN</dd>
        </div>
        <div>
          <dt>Stall speed</dt>
          <dd>{kmh(cfg.stallSpeed)} km/h</dd>
        </div>
      </dl>
    </button>
  );
}

export function AircraftSelect({
  selectedId,
  onSelect,
  onFly,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
  onFly: () => void;
}) {
  const fleet = listAircraft();
  const selected = fleet.find((c) => c.id === selectedId) ?? fleet[0];

  // Enter flies with the current selection — the screen's one job.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Enter") onFly();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onFly]);

  return (
    <div className="select-root">
      <header className="select-head">
        <div className="select-overline">Flight Simulator</div>
        <h1>Choose your aircraft</h1>
        <p>Three aircraft, one island. You can swap any time from the cockpit.</p>
      </header>

      <div className="select-grid" aria-label="Aircraft selection">
        {fleet.map((cfg) => (
          <AircraftCard
            key={cfg.id}
            cfg={cfg}
            selected={cfg.id === selected.id}
            onSelect={() => onSelect(cfg.id)}
            onFly={onFly}
          />
        ))}
      </div>

      <button type="button" className="select-fly" onClick={onFly}>
        ✈ Fly the {selected.name}
      </button>
      <p className="select-hint">
        Press Enter to fly · double-click a card to jump straight in · full controls are under
        “? Controls” in flight
      </p>
    </div>
  );
}
