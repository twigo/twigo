import { useEffect, useState } from "react";

const SHOWN_MS = 1500;

type Result = "idle" | "copied" | "failed";

/** Puts `text` on the clipboard when called, and says for a moment whether it could. */
export function useCopy(text: string): [Result, () => void] {
  const [result, setResult] = useState<Result>("idle");
  useEffect(() => {
    if (result === "idle") return;
    const timer = setTimeout(() => {
      setResult("idle");
    }, SHOWN_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [result]);
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => {
        setResult("copied");
      },
      () => {
        setResult("failed");
      },
    );
  };
  return [result, copy];
}
