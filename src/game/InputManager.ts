/**
 * Keyboard input for the flight simulator (Phase 3).
 *
 * Design:
 * - Listeners are registered exactly once (constructor) and removed in
 *   dispose(). Nothing else in the game adds keyboard listeners.
 * - Continuous actions (pitch/roll/yaw/throttle) read `isDown()` — a set
 *   of currently held `KeyboardEvent.code` values (layout independent).
 * - One-shot actions (reset, camera switch) read `wasJustPressed()`,
 *   filled only by non-repeat keydowns and cleared by `postUpdate()`
 *   at the end of every frame.
 * - If the window loses focus (or the tab is hidden) all state is
 *   cleared, so a key released while unfocused can never "stick".
 */
export const GAME_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyQ",
  "KeyE",
  "KeyC",
  "KeyR",
  "ShiftLeft",
  "ShiftRight",
  "Space",
]);

export interface ControlAxes {
  pitch: number;
  roll: number;
  yaw: number;
}

const GAMEPAD_DEADZONE = 0.18;

export class InputManager {
  private readonly keysDown = new Set<string>();
  private readonly justPressed = new Set<string>();
  private disposed = false;

  // Phase 14: gamepad support. The pad is polled (never events
  // for axes); button rising edges are detected in postUpdate()
  // and fed into the same justPressed set the keyboard uses, so
  // FlightScene/App see one unified input surface.
  private padProvider: (() => Gamepad | null) | null = null;
  private prevPadButtons: boolean[] = [];
  private padConnected = false;
  onGamepadConnectionChange: ((connected: boolean) => void) | null = null;

  private readonly onGamepadConnected = () => {
    this.padConnected = true;
    this.onGamepadConnectionChange?.(true);
  };
  private readonly onGamepadDisconnected = () => {
    this.padConnected = false;
    this.prevPadButtons = [];
    this.onGamepadConnectionChange?.(false);
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!GAME_KEYS.has(event.code)) return;
    // Don't fight browser/OS shortcuts that involve modifier combos
    if (!event.metaKey && !event.altKey) event.preventDefault();
    if (!event.repeat) this.justPressed.add(event.code);
    this.keysDown.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.keysDown.delete(event.code);
  };

  private readonly clearAll = () => {
    this.keysDown.clear();
    this.justPressed.clear();
  };

  private readonly onVisibilityChange = () => {
    if (document.hidden) this.clearAll();
  };

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.clearAll);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("gamepadconnected", this.onGamepadConnected);
    window.addEventListener("gamepaddisconnected", this.onGamepadDisconnected);
  }

  /** Tests (and future remapping UIs) can feed a synthetic pad. */
  setGamepadProvider(provider: (() => Gamepad | null) | null): void {
    this.padProvider = provider;
    this.prevPadButtons = [];
  }

  get gamepadConnected(): boolean {
    return this.padConnected || this.currentPad() !== null;
  }

  private currentPad(): Gamepad | null {
    if (this.padProvider) {
      try {
        return this.padProvider();
      } catch {
        return null;
      }
    }
    if (typeof navigator === "undefined" || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const pad of pads) if (pad) return pad;
    return null;
  }

  /** True while any of the given key codes is physically held down. */
  isDown(...codes: string[]): boolean {
    if (codes.some((code) => this.keysDown.has(code))) return true;
    // Gamepad equivalents for the two held-key actions the
    // controller polls: RT = throttle up (Shift), LT/B = cut (Space).
    const pad = this.currentPad();
    if (!pad) return false;
    for (const code of codes) {
      if (code === "ShiftLeft" || code === "ShiftRight") {
        const rt = pad.buttons[7];
        if (rt && (rt.pressed || rt.value > 0.3)) return true;
      }
      if (code === "Space") {
        if (pad.buttons[6]?.pressed || pad.buttons[1]?.pressed) return true;
      }
    }
    return false;
  }

  /**
   * Combined control targets in [-1, 1] — exactly the values the
   * keyboard produced before Phase 14, plus gamepad sticks:
   * left stick = pitch/roll, right stick X + bumpers = yaw.
   * (Signs follow the 0.12.1 control swap: stick right banks
   * right and yaws right.)
   */
  controlAxes(out: ControlAxes): ControlAxes {
    let pitch = (this.keysDown.has("KeyS") ? 1 : 0) + (this.keysDown.has("KeyW") ? -1 : 0);
    let roll = (this.keysDown.has("KeyD") ? 1 : 0) + (this.keysDown.has("KeyA") ? -1 : 0);
    let yaw = (this.keysDown.has("KeyE") ? 1 : 0) + (this.keysDown.has("KeyQ") ? -1 : 0);
    const pad = this.currentPad();
    if (pad) {
      const dz = (v: number | undefined) => {
        const a = Math.abs(v ?? 0);
        if (a < GAMEPAD_DEADZONE) return 0;
        return (Math.sign(v ?? 0) * (a - GAMEPAD_DEADZONE)) / (1 - GAMEPAD_DEADZONE);
      };
      pitch += dz(pad.axes[1]);
      roll += -dz(pad.axes[0]);
      yaw += -dz(pad.axes[2]);
      if (pad.buttons[4]?.pressed) yaw += 1; // LB: yaw left
      if (pad.buttons[5]?.pressed) yaw -= 1; // RB: yaw right
    }
    out.pitch = Math.max(-1, Math.min(1, pitch));
    out.roll = Math.max(-1, Math.min(1, roll));
    out.yaw = Math.max(-1, Math.min(1, yaw));
    return out;
  }

  /** True only on the first frame after the key was pressed. */
  wasJustPressed(code: string): boolean {
    return this.justPressed.has(code);
  }

  /** Call once at the very end of each frame's update. */
  postUpdate(): void {
    this.justPressed.clear();
    this.pollGamepadEdges();
  }

  /** Rising-edge pad buttons -> the same edges keyboard produces. */
  private pollGamepadEdges(): void {
    const pad = this.currentPad();
    if (!pad) {
      this.prevPadButtons = [];
      return;
    }
    const now = pad.buttons.map((b) => !!b?.pressed);
    const rose = (i: number) => now[i] && !this.prevPadButtons[i];
    if (rose(0)) this.justPressed.add("KeyC"); // A: cycle camera
    if (rose(3)) this.justPressed.add("KeyR"); // Y: reset aircraft
    if (rose(9)) {
      // Start: pause — App owns KeyP, so hand it a synthetic press.
      try {
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyP" }));
      } catch {
        // Non-DOM environment: pause-by-pad just isn't available.
      }
    }
    this.prevPadButtons = now;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.clearAll);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("gamepadconnected", this.onGamepadConnected);
    window.removeEventListener("gamepaddisconnected", this.onGamepadDisconnected);
    this.clearAll();
  }
}
