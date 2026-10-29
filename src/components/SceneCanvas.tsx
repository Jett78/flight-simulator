import { useEffect, useRef } from "react";
import { FlightScene } from "../game/FlightScene";

/**
 * React host for the Babylon.js canvas.
 * Creates the FlightScene on mount and disposes it on unmount
 * (safe under React StrictMode's double-mount in development).
 */
export function SceneCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const flightScene = new FlightScene(canvas);
    return () => flightScene.dispose();
  }, []);

  return (
    <canvas
      ref={canvasRef}
      id="flight-canvas"
      aria-label="3D flight simulator scene"
      style={{
        width: "100%",
        height: "100%",
        display: "block",
        outline: "none",
        touchAction: "none",
      }}
    />
  );
}
