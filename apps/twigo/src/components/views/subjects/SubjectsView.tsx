import { useMemo } from "react";
import { Square } from "lucide-react";
import { Button } from "@twigo/ui";
import { useConnections } from "@/store/connections";
import { useSubjects } from "@/store/subjects";
import { buildSubjectTree } from "@twigo/utils";
import { openStream } from "@/lib/editor";
import { SubjectTree } from "./SubjectTree";
import { WatchForm } from "./WatchForm";

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

export function SubjectsView({ filter }: { filter: string }) {
  const { activeContext, connected } = useConnections();
  const isConnected = !!(activeContext && connected[activeContext]);
  const data = useSubjects((s) =>
    activeContext ? s.byConn[activeContext] : undefined,
  );
  const watchingPattern = useSubjects((s) =>
    activeContext ? s.watching[activeContext] : undefined,
  );
  const startWatch = useSubjects((s) => s.startWatch);
  const stopWatch = useSubjects((s) => s.stopWatch);

  const tree = useMemo(() => {
    const stats = data?.stats ?? [];
    const f = filter.trim().toLowerCase();
    const filtered = f
      ? stats.filter((s) => s.subject.toLowerCase().includes(f))
      : stats;
    return buildSubjectTree(filtered);
  }, [data?.stats, filter]);

  if (!isConnected || !activeContext) {
    return <Hint>Connect to a server to explore subjects.</Hint>;
  }

  if (!watchingPattern) {
    return (
      <WatchForm
        onStart={(pattern) => void startWatch(activeContext, pattern)}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-ok" />
          <span className="truncate font-mono">{watchingPattern}</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void stopWatch(activeContext)}
        >
          <Square />
          Stop
        </Button>
      </div>
      {tree.length === 0 ? (
        <Hint>
          {filter ? "No matching subjects." : "No messages observed yet."}
        </Hint>
      ) : (
        <SubjectTree
          nodes={tree}
          connId={activeContext}
          onSelect={(subject) => {
            void openStream(activeContext, subject);
          }}
        />
      )}
      {data?.truncated && (
        <p className="px-2 py-2 text-[11px] text-warn">
          Showing the first 5000 subjects.
        </p>
      )}
    </div>
  );
}
