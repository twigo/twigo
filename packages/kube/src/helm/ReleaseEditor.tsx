import { useEffect, useMemo, useState } from "react";
import { Copy, SquareArrowOutUpRight, X } from "lucide-react";
import { EmptyState, IconButton } from "@twigo/ui";
import { useWorkbench, type EditorProps } from "@twigo/workbench";
import type { ListServices } from "../services";
import { DetailsFrame, DWELL_MS } from "../Details";
import { helmUri, parseHelmUri, type ReleaseInput } from "../uri";
import { ReleasePage } from "./ReleasePage";

/**
 * A `helm://` editor (ARCHITECTURE 4.3): one release as its overview, values,
 * manifest and history, the latest revision followed unless the URI pins one.
 */
export function ReleaseEditor({
  uri,
  services,
}: EditorProps & { services: ListServices }) {
  const { editors } = useWorkbench();
  const input = useMemo(() => parseHelmUri(uri), [uri]);
  if (!input) return <EmptyState title="Not a release">{uri}</EmptyState>;
  return (
    <ReleasePage
      uri={uri}
      release={input}
      services={services}
      controls={(run) => (
        <IconButton
          icon={Copy}
          label="Copy Name"
          onClick={() => {
            run("k8s.resource.copyName");
          }}
        />
      )}
      onOpenRevision={(revision) => {
        editors.pin(uri);
        editors.open(helmUri({ ...input, revision }));
      }}
    />
  );
}

/** A selected row's release as the list's inspector (ARCHITECTURE 4.3), opened once the selection rests on the row. */
export function ReleaseDetails({
  uri,
  release,
  services,
  docked,
  onOpen,
  onClose,
}: {
  /** The list editor the row is in. */
  uri: string;
  release: ReleaseInput;
  services: ListServices;
  docked: boolean;
  onOpen: (release: ReleaseInput) => void;
  onClose: () => void;
}) {
  const key = `${release.space}/${release.namespace}/${release.name}`;
  const [rested, setRested] = useState<string>();
  useEffect(() => {
    const timer = setTimeout(() => {
      setRested(key);
    }, DWELL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [key]);
  return (
    <DetailsFrame
      label="Helm release details"
      docked={docked}
      onElement={() => undefined}
    >
      {rested === key && (
        <ReleasePage
          key={key}
          uri={uri}
          release={release}
          services={services}
          controls={(run) => (
            <>
              <IconButton
                icon={Copy}
                label="Copy Name"
                onClick={() => {
                  run("k8s.resource.copyName");
                }}
              />
              <IconButton
                icon={SquareArrowOutUpRight}
                label="Open in an editor"
                onClick={() => {
                  onOpen(release);
                }}
              />
              <IconButton
                icon={X}
                label="Close details"
                keys="esc"
                onClick={onClose}
              />
            </>
          )}
          onOpenRevision={(revision) => {
            onOpen({ ...release, revision });
          }}
        />
      )}
    </DetailsFrame>
  );
}
