import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, KeyRound, Loader2 } from "lucide-react";
import type { ExecPlugin } from "@twigo/protocol";
import { Button } from "@twigo/ui";
import { useWorkbench } from "../../react";
import { hints, plain, remedy } from "./output";
import type { Shown } from "./useSignIn";

/** What the person needs from a run: the code, the link, or why it failed. */
export function SignInBody({
  plugin,
  status,
  context,
}: {
  plugin: ExecPlugin;
  status: Shown;
  context: string;
}) {
  const { credentials } = useWorkbench();
  const output = plain(status.output).trim();
  const { url, code } = hints(status.output);
  const failed = status.state === "failed";
  const title = failed
    ? plugin.signsIn
      ? `Could not sign in to ${context}`
      : `No credentials for ${context}`
    : plugin.signsIn
      ? `Sign in to ${context}`
      : `Getting credentials for ${context}`;
  const fix = failed ? remedy(status.output, plugin) : undefined;
  return (
    <div className="text-xs">
      <div className="flex items-start gap-2.5 pr-5">
        <KeyRound
          aria-hidden
          className={`mt-0.5 size-4 shrink-0 ${failed ? "text-error" : "text-brand"}`}
        />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold">{title}</p>
          <p
            className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
            title={[plugin.command, ...plugin.args].join(" ")}
          >
            {[plugin.command, ...plugin.args].join(" ")}
          </p>
        </div>
      </div>

      {failed ? (
        <div className="mt-3 space-y-2">
          <p className="text-error">{status.error}</p>
          {fix && (
            <p>
              Run <code className="font-mono">{fix}</code> in a terminal, then
              try again.
            </p>
          )}
          {status.installHint && (
            <p className="whitespace-pre-wrap text-muted-foreground">
              {status.installHint}
            </p>
          )}
        </div>
      ) : code ? (
        <div className="mt-3 space-y-2">
          <p className="text-muted-foreground">
            Enter this code on the sign-in page:
          </p>
          <div className="flex items-center gap-2">
            <span className="select-all rounded-md border border-border bg-muted px-2.5 py-1 font-mono text-base tracking-[0.2em]">
              {code}
            </span>
            <CopyButton text={code} label="Copy code" />
          </div>
          {url && <Link url={url} />}
        </div>
      ) : url ? (
        <div className="mt-3 space-y-2">
          <p className="text-muted-foreground">
            If no browser opened, open this link:
          </p>
          <Link url={url} />
        </div>
      ) : (
        <p className="mt-3 flex items-center gap-2 text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          {plugin.signsIn
            ? "Finish signing in in your browser."
            : "Waiting for the plugin."}
        </p>
      )}

      {output !== "" && (
        <Output key={status.state} text={output} open={failed} />
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="tabular-nums text-muted-foreground">
          {status.state === "running" && <Elapsed since={status.since} />}
        </span>
        <div className="flex gap-2">
          {failed ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  credentials.setPanelOpen(false);
                }}
              >
                Close
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  void credentials.signIn();
                }}
              >
                Try again
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void credentials.cancel();
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A button, not an anchor: a link the webview could follow would put the sign-in page in Twigo's own window. */
function Link({ url }: { url: string }) {
  const workbench = useWorkbench();
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="min-w-0 truncate font-mono text-[11px] text-brand underline-offset-2 hover:underline"
        title={`Open ${url}`}
        onClick={() => {
          workbench.openUrl(url);
        }}
      >
        {url}
      </button>
      <ExternalLink aria-hidden className="size-3 shrink-0 text-brand" />
      <CopyButton text={url} label="Copy link" />
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const workbench = useWorkbench();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      title={label}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => {
              setCopied(false);
            }, 1500);
          },
          (error: unknown) => {
            workbench.report(error);
          },
        );
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

function Output({ text, open }: { text: string; open: boolean }) {
  const [shown, setShown] = useState(open);
  return (
    <div className="mt-2">
      <button
        type="button"
        className="text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => {
          setShown(!shown);
        }}
      >
        {shown ? "Hide output" : "Show output"}
      </button>
      {shown && (
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-2 font-mono text-[11px]">
          {text}
        </pre>
      )}
    </div>
  );
}

function Elapsed({ since }: { since: string }) {
  const started = Date.parse(since);
  const [now, setNow] = useState(started);
  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  return (
    <>
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </>
  );
}
