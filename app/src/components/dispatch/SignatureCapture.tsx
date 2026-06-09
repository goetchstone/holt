// /app/src/components/dispatch/SignatureCapture.tsx

import { useRef, useEffect, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";

interface SignatureCaptureProps {
  onSave: (base64: string) => void;
  width?: number;
  height?: number;
}

export default function SignatureCapture({
  onSave,
  width = 300,
  height = 150,
}: SignatureCaptureProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasStrokes, setHasStrokes] = useState(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);

  const getCanvasPoint = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY,
      };
    },
    [],
  );

  const drawLine = useCallback((from: { x: number; y: number }, to: { x: number; y: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }, []);

  // Fill canvas with white on mount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, [width, height]);

  // Touch handlers
  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      e.preventDefault();
      const touch = e.touches[0];
      const point = getCanvasPoint(touch.clientX, touch.clientY);
      lastPoint.current = point;
      setIsDrawing(true);
      setHasStrokes(true);
    },
    [getCanvasPoint],
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      e.preventDefault();
      if (!isDrawing || !lastPoint.current) return;
      const touch = e.touches[0];
      const point = getCanvasPoint(touch.clientX, touch.clientY);
      drawLine(lastPoint.current, point);
      lastPoint.current = point;
    },
    [isDrawing, getCanvasPoint, drawLine],
  );

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    e.preventDefault();
    setIsDrawing(false);
    lastPoint.current = null;
  }, []);

  // Mouse handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const point = getCanvasPoint(e.clientX, e.clientY);
      lastPoint.current = point;
      setIsDrawing(true);
      setHasStrokes(true);
    },
    [getCanvasPoint],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDrawing || !lastPoint.current) return;
      const point = getCanvasPoint(e.clientX, e.clientY);
      drawLine(lastPoint.current, point);
      lastPoint.current = point;
    },
    [isDrawing, getCanvasPoint, drawLine],
  );

  const handleMouseUp = useCallback(() => {
    setIsDrawing(false);
    lastPoint.current = null;
  }, []);

  // Attach touch listeners with passive: false to prevent scroll
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.addEventListener("touchstart", handleTouchStart, { passive: false });
    canvas.addEventListener("touchmove", handleTouchMove, { passive: false });
    canvas.addEventListener("touchend", handleTouchEnd, { passive: false });

    return () => {
      canvas.removeEventListener("touchstart", handleTouchStart);
      canvas.removeEventListener("touchmove", handleTouchMove);
      canvas.removeEventListener("touchend", handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  function clearCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setHasStrokes(false);
  }

  function handleAccept() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onSave(canvas.toDataURL("image/png"));
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-sh-gray">Sign below</span>
        <button
          type="button"
          onClick={clearCanvas}
          className="text-xs text-sh-blue hover:underline min-h-[44px] min-w-[44px] flex items-center justify-center"
        >
          Clear
        </button>
      </div>

      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="w-full border border-sh-gray/30 rounded-lg bg-white touch-none"
        style={{ minWidth: 300, minHeight: 150 }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />

      <Button
        fullWidth
        onClick={handleAccept}
        disabled={!hasStrokes}
        className="min-h-[60px] text-base"
      >
        Accept Signature
      </Button>
    </div>
  );
}
