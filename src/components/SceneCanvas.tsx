import { useEffect, useRef } from "react";
import { FlightScene } from "../game/FlightScene";

interface SceneCanvasProps {
  /** Called with the live FlightScene once created (null on unmount),
   *  so React UI can call into it — e.g. the camera reset button. */
  onReady?: (scene: FlightScene | null) => void;
}

/**
 * React host for the Babylon.js canvas.
 * Creates the FlightScene on mount and disposes it on unmount
 * (safe under React StrictMode's double-mount in development).
 */
export function SceneCanvas({ onReady }: SceneCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const flightScene = new FlightScene(canvas);
    onReadyRef.current?.(flightScene);
    return () => {
      onReadyRef.current?.(null);
      flightScene.dispose();
    };
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
