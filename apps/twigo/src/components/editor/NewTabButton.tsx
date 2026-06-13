import { Plus } from "lucide-react";
import { useConnections } from "@/store/connections";
import { newPublish } from "@/lib/actions";

const BTN =
  "flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-transparent";

export function NewTabButton() {
  const hasLive = useConnections((s) =>
    Object.values(s.connected).some((i) => i.connected),
  );
  return (
    <div className="mr-1 flex h-full items-center">
      <button
        type="button"
        aria-label="New publish"
        title={hasLive ? "New publish" : "Connect a context to publish"}
        disabled={!hasLive}
        onClick={() => newPublish()}
        className={BTN}
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}
