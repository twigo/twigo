import "@xterm/xterm/css/xterm.css";
import { useEffect, useMemo, useState } from "react";
import { Terminal } from "lucide-react";
import { EmptyState } from "@twigo/ui";
import {
  useChanges,
  useWorkbench,
  type EditorProps,
  type Lookup,
} from "@twigo/workbench";
import { parseTerminalUri } from "../uri";
import { useTerminalHost } from "../xterm/useTerminalHost";
import { KindBar } from "./KindBar";
import { OfferBar } from "./OfferBar";
import type { KubeconfigOffers } from "./offers";
import type { TerminalTabs } from "./tabs";
import { useKind } from "./useKind";
import { terminalTitle } from "./words";

/** The command that starts a terminal again; its button asks it of a tab that has ended or never started. */
export const RESTART_TERMINAL = "k8s.terminal.restart";

/**
 * A terminal tab in the panel (ARCHITECTURE 4.6): the terminal the service
 * keeps for its URI, moved into this view while it shows, and what the
 * terminal cannot say: that nothing started it.
 */
export function TerminalEditor({
  uri,
  tabs,
  offers,
}: EditorProps & { tabs: TerminalTabs; offers: KubeconfigOffers }) {
  const { keys, commands } = useWorkbench();
  useChanges(tabs.changes);
  const input = useMemo(() => parseTerminalUri(uri), [uri]);
  const tab = useMemo(
    () => (input ? tabs.tab(uri, input) : undefined),
    [input, tabs, uri],
  );
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const setContainer = useTerminalHost(tab, uri, input?.space);
  const status = tab?.getStatus();
  const words = useKind(tab);
  const restartable =
    status?.state === "ended" ||
    status?.state === "restored" ||
    words?.warning !== undefined;

  useEffect(() => {
    if (!root) return;
    const scope = keys.scope(root);
    scope.set("terminalFocus", true);
    scope.set("terminalRestartable", restartable);
    return () => {
      scope.dispose();
    };
  }, [root, keys, restartable]);

  const restored = status?.state === "restored";
  useEffect(() => {
    if (!tab || !root || !restored) return;
    tab.setRestoredView(root);
    return () => {
      tab.setRestoredView(null);
    };
  }, [tab, root, restored]);

  if (!input || !tab || !status) {
    return (
      <EmptyState title="Not a terminal tab" className="h-full">
        {uri}
      </EmptyState>
    );
  }

  const restart = () => {
    const lookup: Lookup = (key) =>
      key === "terminalRestartable" ? true : keys.lookup(root)(key);
    void commands.execute(RESTART_TERMINAL, lookup, { uri });
  };

  if (restored) {
    return (
      <div
        ref={setRoot}
        tabIndex={-1}
        className="h-full bg-editor outline-none"
      >
        <EmptyState
          icon={Terminal}
          title="This terminal ended when Twigo closed"
          action={{ label: "Restart", onClick: restart }}
          className="h-full"
        >
          <p>{terminalTitle(input)}</p>
          <p>A terminal cannot be resumed; Restart opens a new one.</p>
        </EmptyState>
      </div>
    );
  }

  return (
    <div ref={setRoot} className="flex h-full min-h-0 flex-col bg-editor">
      <OfferBar uri={uri} tabs={tabs} offers={offers} />
      {words && <KindBar words={words} restart={restart} />}
      <div ref={setContainer} className="min-h-0 flex-1 pt-1 pl-2" />
    </div>
  );
}
