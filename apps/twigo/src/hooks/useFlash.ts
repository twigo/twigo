import { useEffect, useRef, useState } from "react";

// True while `value` keeps changing (resets the timer on each change), then
// false `ms` after it settles. Drives a steady "this is live right now" glow on
// continuously-updating numbers - not a per-tick blink.
export function useFlash(value: number, ms = 500): boolean {
  const prev = useRef(value);
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    setOn(true);
    const id = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(id);
  }, [value, ms]);

  return on;
}
