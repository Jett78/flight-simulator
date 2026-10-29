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
  "ArrowUp",
  "ArrowDown",
]);

export class InputManager {
  private readonly keysDown = new Set<string>();
  private readonly justPressed = new Set<string>();
  private disposed = false;

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
  }

  /** True while any of the given key codes is physically held down. */
  isDown(...codes: string[]): boolean {
    return codes.some((code) => this.keysDown.has(code));
  }

  /** True only on the first frame after the key was pressed. */
  wasJustPressed(code: string): boolean {
    return this.justPressed.has(code);
  }

  /** Call once at the very end of each frame's update. */
  postUpdate(): void {
    this.justPressed.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.clearAll);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.clearAll();
  }
}
