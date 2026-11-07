import { useEffect, useState } from "react";
import { LockOpen } from "lucide-react";
import { Banner, Button } from "@twigo/ui";
import { useChanges, useWorkbench } from "../react";
import { RELOCK_CONTEXT } from "../spaces/modeCommands";
import { accessOfSpace, countdown } from "../spaces/modes";

/**
 * Across the window while the active context is unlocked (ARCHITECTURE 6.4),
 * counting down to the relock, which Rust does by itself.
 */
export function UnlockBanner() {
  const { spaces, catalog, commands, keys } = useWorkbench();
  useChanges(spaces.changes);
  useChanges(catalog.changes);
  const space = spaces.active;
  const until = (space && accessOfSpace(catalog, space))?.unlockedUntil ?? null;
  if (!space || until === null) return null;
  return (
    <Banner
      tone="warn"
      icon={LockOpen}
      title={`${space.name} is unlocked.`}
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void commands.execute(RELOCK_CONTEXT, keys.lookup(null));
          }}
        >
          Lock now
        </Button>
      }
    >
      Every change asks first. It locks again in{" "}
      <Countdown key={until} until={until} />.
    </Banner>
  );
}

function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return <span className="tabular-nums">{countdown(until - now)}</span>;
}
