import { useState } from "react";

/** A key that mounts a part anew, and the call that changes it: Reopen, so that what the part opens starts again from nothing. */
export function useReopen(): [key: number, reopen: () => void] {
  const [key, setKey] = useState(0);
  return [
    key,
    () => {
      setKey((n) => n + 1);
    },
  ];
}
