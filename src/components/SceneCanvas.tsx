import { useEffect, useRef } from "react";
import { FlightScene } from "../game/FlightScene";

interface SceneCanvasProps {
  /** Called with the live FlightScene once created (null on unmount),
   *  so React UI can call into it — e.g. the camera reset button. */
  onReady?: (scene: FlightScene | null) => void;
  /** Multi-aircraft Phase 2: the selected aircraft's registry id.
   *  The scene is (re)built with this aircraft's configuration. */
  aircraftId: string;
}

/**
 * React host for the Babylon.js canvas.
 * Creates the FlightScene on mount and disposes it on unmount
 * (safe under React StrictMode's double-mount in development).
 */
export function SceneCanvas({ onReady, aircraftId }: SceneCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const flightScene = new FlightScene(canvas, aircraftId);
    onReadyRef.current?.(flightScene);
    return () => {
      onReadyRef.current?.(null);
      flightScene.dispose();
    };
    // Rebuild the whole scene when the aircraft changes: the
    // config shapes physics, camera and model fit from birth.
  }, [aircraftId]);

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
