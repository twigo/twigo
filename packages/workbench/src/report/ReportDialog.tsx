import { useState } from "react";
import {
  toIpcError,
  type Fact,
  type FactId,
  type IpcError,
  type Report,
} from "@twigo/protocol";
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  LinkButton,
  notify,
  PropertyList,
  TextArea,
  type Property,
} from "@twigo/ui";
import { ErrorMessage } from "../ErrorMessage";
import { useChanges, useReturnFocus, useWorkbench } from "../react";
import { REVEAL_LOG_FILE } from "./commands";
import { hiddenWords, reportText, SECURITY_URL } from "./words";

/**
 * "Report a Problem" (ARCHITECTURE 4.10): what Rust prepared and redacted,
 * for the person to read, edit and send their own way. Nothing leaves
 * before a button.
 */
export function ReportDialog() {
  const { problemReport } = useWorkbench();
  useChanges(problemReport.changes);
  const { report } = problemReport;
  const returnFocus = useReturnFocus(report !== undefined);
  if (!report) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) problemReport.close();
      }}
    >
      <DialogContent
        className="flex max-h-[calc(82%-24px)] max-w-[880px] flex-col p-4"
        onCloseAutoFocus={returnFocus}
      >
        <Body report={report} />
      </DialogContent>
    </Dialog>
  );
}

function Body({ report }: { report: Report }) {
  const workbench = useWorkbench();
  const { backend, commands, keys, problemReport } = workbench;
  const [ticked, setTicked] = useState<ReadonlySet<FactId>>(
    () => new Set(report.facts.map(({ id }) => id)),
  );
  const [log, setLog] = useState(report.log);
  const [error, setError] = useState<IpcError>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const stated = report.facts.filter(({ id }) => ticked.has(id));
  const text = reportText({ facts: stated, log });
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (failure) {
      setError(toIpcError(failure));
    } finally {
      setBusy(false);
    }
  };

  const openIssue = () => {
    // Written in the click's own turn: WKWebView may not allow it after an
    // IPC round trip (not verified).
    const written = navigator.clipboard.writeText(log);
    void run(async () => {
      await written;
      await backend.invoke("report_open_issue", {
        facts: stated.map(({ id }) => id),
      });
      problemReport.close();
      notify.info("The log is on your clipboard: paste it into Logs.", {
        key: "report:opened",
      });
    });
  };

  const save = () => {
    void run(async () => {
      const path = await backend.invoke("report_save", { text });
      if (path !== null) notify.success(`Saved to ${path}`);
    });
  };

  const copy = () => {
    void run(async () => {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1500);
    });
  };

  const facts: Property[] = report.facts.map((fact) => ({
    key: fact.id,
    label: fact.label,
    value: (
      <Stated
        fact={fact}
        on={ticked.has(fact.id)}
        onChange={(on) => {
          const next = new Set(ticked);
          if (on) next.add(fact.id);
          else next.delete(fact.id);
          setTicked(next);
        }}
      />
    ),
  }));

  return (
    <>
      <DialogTitle className="text-body font-semibold">
        Report a problem
      </DialogTitle>
      <DialogDescription className="mt-1 text-xs text-support">
        Twigo opens a new issue on GitHub, which anyone can read, with what is
        below. Nothing leaves this computer until you choose, and Twigo itself
        sends nothing.
      </DialogDescription>
      <div className="mt-3 grid min-h-0 flex-1 gap-3 overflow-auto">
        <section aria-label="In the issue" className="grid gap-1">
          <h3 className="text-2xs font-semibold text-support">In the issue</h3>
          <PropertyList items={facts} />
        </section>
        <section aria-label="For you to paste" className="grid gap-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-2xs font-semibold text-support">
              For you to paste
            </h3>
            <LinkButton
              className="text-xs"
              onClick={() => {
                void commands.execute(REVEAL_LOG_FILE, keys.lookup(null));
              }}
            >
              Reveal Log File
            </LinkButton>
          </div>
          <TextArea
            mono
            aria-label="Log"
            wrap="off"
            rows={11}
            value={log}
            onChange={(event) => {
              setLog(event.target.value);
            }}
          />
          <p className="text-xs text-quiet">{hiddenWords(report.hidden)}</p>
        </section>
        {error && (
          <div role="alert">
            <Callout tone="error" title={<ErrorMessage error={error} />} />
          </div>
        )}
        <p className="text-xs text-support">
          Security problem?{" "}
          <LinkButton
            onClick={() => {
              workbench.openUrl(SECURITY_URL);
            }}
          >
            Report it privately.
          </LinkButton>
        </p>
      </div>
      <DialogFooter>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            problemReport.close();
          }}
        >
          Cancel
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={save}>
          Save…
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button size="sm" disabled={busy} onClick={openIssue}>
          Open Issue on GitHub
        </Button>
      </DialogFooter>
    </>
  );
}

function Stated({
  fact,
  on,
  onChange,
}: {
  fact: Fact;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  if (!fact.optional) return <span className="block pl-6">{fact.value}</span>;
  return (
    <label className="relative block cursor-pointer pl-6">
      <input
        type="checkbox"
        className="absolute top-px left-0 size-4 accent-brand"
        checked={on}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      {fact.value}
    </label>
  );
}
