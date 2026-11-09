import "@xterm/xterm/css/xterm.css";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Hourglass, SquareTerminal } from "lucide-react";
import { CLUSTER_SESSIONS } from "@twigo/protocol";
import { Banner, EmptyState } from "@twigo/ui";
import {
  useChanges,
  useEditorShown,
  useWorkbench,
  type EditorProps,
  type Lookup,
} from "@twigo/workbench";
import { parseExecUri } from "../uri";
import type { ExecTabs } from "./tabs";
import { execTitle } from "./words";

/** The command that starts a tab's shell again; its button asks it of a tab that has ended or never started. */
export const RESTART_SHELL = "k8s.shell.restart";

/**
 * A shell tab in the panel (ARCHITECTURE 4.6): the terminal the service
 * keeps for its URI, moved into this view while it shows, and what the
 * session says that the terminal cannot: that it waits for a place, that it
 * ended, that nothing started it.
 */
export function ExecEditor({ uri, tabs }: EditorProps & { tabs: ExecTabs }) {
  const { keys, spaces, commands } = useWorkbench();
  useChanges(tabs.changes);
  useChanges(spaces.changes);
  const input = useMemo(() => parseExecUri(uri), [uri]);
  const tab = useMemo(
    () => (input ? tabs.tab(uri, input) : undefined),
    [input, tabs, uri],
  );
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const editorShown = useEditorShown();
  const panelVisible = input
    ? spaces.state(input.space).parts.panel.visible
    : false;
  const shown = editorShown && panelVisible;
  const status = tab?.getStatus();
  const ended = status?.state === "ended" || status?.state === "restored";

  useLayoutEffect(() => {
    if (!tab || !container) return;
    tab.attach(container);
    const observer = new ResizeObserver(() => {
      tab.layout();
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [tab, container]);

  useEffect(() => {
    if (!tab || !container) return;
    tab.setShown(shown);
    return () => {
      tab.setShown(false);
    };
  }, [tab, container, shown]);

  useEffect(() => {
    if (!root) return;
    const scope = keys.scope(root);
    scope.set("execEnded", ended);
    return () => {
      scope.dispose();
    };
  }, [root, keys, ended]);

  if (!input || !tab || !status) {
    return (
      <EmptyState title="Not a shell tab" className="h-full">
        {uri}
      </EmptyState>
    );
  }

  const restart = () => {
    const lookup: Lookup = (key) =>
      key === "execEnded" ? true : keys.lookup(root)(key);
    void commands.execute(RESTART_SHELL, lookup, { uri });
  };

  if (status.state === "restored") {
    return (
      <div ref={setRoot} className="h-full bg-editor">
        <EmptyState
          icon={SquareTerminal}
          title="This shell ended when Twigo closed"
          action={{ label: "Start", onClick: restart }}
          className="h-full"
        >
          <p>{execTitle(input)}</p>
          <p>A shell cannot be resumed; Start opens a new one.</p>
        </EmptyState>
      </div>
    );
  }

  return (
    <div ref={setRoot} className="flex h-full min-h-0 flex-col bg-editor">
      {status.state === "queued" && (
        <Banner
          tone="warn"
          icon={Hourglass}
          title={`Waiting for a place among the cluster's ${String(CLUSTER_SESSIONS)} sessions.`}
        >
          Close a shell to free one.
        </Banner>
      )}
      <div ref={setContainer} className="min-h-0 flex-1" />
    </div>
  );
}
