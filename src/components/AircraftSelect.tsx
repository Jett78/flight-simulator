import { useEffect } from "react";
import {
  listAircraft,
  AIRCRAFT_CATEGORY_LABELS,
  type AircraftCategory,
  type AircraftConfig,
} from "../game/aircraftConfigs";
import "./AircraftSelect.css";

/**
 * Multi-aircraft Phase 2 — the pre-flight aircraft selection
 * screen. Shown before a flight starts; the chosen config is
 * handed to FlightScene at construction, so the whole game
 * (physics, camera, model fit) initializes with it — this is
 * the game's start screen, not a HUD name tag.
 *
 * Previews are hand-drawn SVG silhouettes per category —
 * placeholders until real aircraft imagery/models arrive.
 */

function AircraftArt({ category }: { category: AircraftCategory }) {
  const common = {
    viewBox: "0 0 260 100",
    role: "img" as const,
    "aria-hidden": true,
    focusable: false,
  };
  if (category === "commercial-jet") {
    return (
      <svg {...common}>
        <path className="art-body" d="M14 56 Q10 46 30 42 L90 36 Q160 32 215 40 L240 46 Q252 50 246 58 Q240 65 215 66 L70 68 Q24 66 14 56 Z" />
        <polygon className="art-wing" points="105,56 150,86 170,86 140,52" />
        <rect className="art-detail" x="116" y="64" width="17" height="9" rx="4" />
        <rect className="art-detail" x="148" y="68" width="15" height="8" rx="4" />
        <polygon className="art-wing" points="208,40 228,13 241,13 236,44" />
        <polygon className="art-detail" points="216,60 244,54 246,61 220,67" />
        <circle className="art-window" cx="52" cy="47" r="2.2" />
        <circle className="art-window" cx="66" cy="46" r="2.2" />
        <circle className="art-window" cx="80" cy="45" r="2.2" />
        <circle className="art-window" cx="94" cy="44" r="2.2" />
      </svg>
    );
  }
  if (category === "fighter") {
    return (
      <svg {...common}>
        <path className="art-body" d="M8 54 L60 44 Q130 37 190 44 L236 50 Q247 53 236 57 L180 64 Q100 69 50 62 L14 58 Q6 57 8 54 Z" />
        <ellipse className="art-detail" cx="96" cy="42" rx="17" ry="6" />
        <polygon className="art-wing" points="108,55 182,87 204,87 158,51" />
        <polygon className="art-wing" points="196,44 214,19 227,19 224,48" />
        <polygon className="art-detail" points="30,57 62,60 58,64 28,61" />
      </svg>
    );
  }
  // Propeller — the Cesium Air: high wing, twin nacelles, nose prop.
  return (
    <svg {...common}>
      <ellipse className="art-prop" cx="15" cy="55" rx="4" ry="21" />
      <path className="art-body" d="M20 58 Q14 50 27 46 L72 40 Q122 35 176 42 L214 48 Q231 50 229 58 Q227 66 209 68 L82 70 Q31 70 20 58 Z" />
      <polygon className="art-wing" points="94,39 152,34 158,42 100,47" />
      <rect className="art-detail" x="102" y="47" width="27" height="11" rx="5" />
      <polygon className="art-wing" points="204,47 221,25 232,25 228,50" />
      <polygon className="art-detail" points="211,62 237,58 239,65 213,69" />
      <circle className="art-window" cx="58" cy="47" r="2.4" />
      <circle className="art-window" cx="72" cy="46" r="2.4" />
    </svg>
  );
}

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
      <div className="select-art">
        <AircraftArt category={cfg.category} />
      </div>
      <div className="select-card-top">
        <h2>{cfg.name}</h2>
        <span className="select-chip">{AIRCRAFT_CATEGORY_LABELS[cfg.category]}</span>
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
      {selected && <div className="select-selected">✓ Selected</div>}
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
        <div className="select-badge">FLIGHT SIMULATOR</div>
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
        ✈ Fly Now
        <span className="select-fly-sub">in the {selected.name}</span>
      </button>
      <p className="select-hint">
        Press Enter to fly · double-click a card to jump straight in · full controls are under
        “? Controls” in flight
      </p>
    </div>
  );
}
