import { useEffect, useState } from "react";
import { CircleAlert } from "lucide-react";
import { PODS, ResourceTable } from "@twigo/kube";
import { toIpcError, type Backend, type Space } from "@twigo/protocol";
import { EmptyState } from "@twigo/ui";
import { Workbench } from "@twigo/workbench";

export function App({ backend }: { backend: Backend }) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [active, setActive] = useState<string>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    backend.invoke("spaces_list", null).then(
      (list) => {
        setSpaces(list);
        setActive((current) => current ?? list[0]?.id);
      },
      (error: unknown) => {
        setFailure(toIpcError(error).message);
      },
    );
  }, [backend]);

  return (
    <Workbench spaces={spaces} active={active} onSelectSpace={setActive}>
      {failure !== undefined ? (
        <EmptyState
          icon={CircleAlert}
          variant="error"
          title="Could not load the spaces"
          className="h-full"
        >
          <p className="text-muted-foreground">{failure}</p>
        </EmptyState>
      ) : (
        active && (
          <ResourceTable
            key={active}
            backend={backend}
            space={active}
            gvr={PODS}
            title="Pods"
          />
        )
      )}
    </Workbench>
  );
}
