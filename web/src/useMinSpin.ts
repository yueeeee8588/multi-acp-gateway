import { useEffect, useRef, useState } from "react";

export function useMinSpin(active: boolean, minMs = 450): boolean {
  const [spinning, setSpinning] = useState(active);
  const startedAtRef = useRef<number>(active ? Date.now() : 0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (active) {
      startedAtRef.current = Date.now();
      setSpinning(true);
      return;
    }

    const elapsed = startedAtRef.current ? Date.now() - startedAtRef.current : minMs;
    const remaining = Math.max(0, minMs - elapsed);
    if (remaining === 0) {
      startedAtRef.current = 0;
      setSpinning(false);
      return;
    }

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      startedAtRef.current = 0;
      setSpinning(false);
    }, remaining);
  }, [active, minMs]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return spinning;
}
