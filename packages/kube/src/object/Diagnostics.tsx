import { History, ScrollText } from "lucide-react";
import type { Finding } from "@twigo/protocol";
import { Button, Callout } from "@twigo/ui";
import { Sentence } from "./values";

/** Which logs of a container a finding's button opens. */
export interface FindingLogsChoice {
  readonly container: string;
  readonly previous: boolean;
}

/**
 * What is wrong with an object, first in its Overview (ARCHITECTURE 4.3):
 * each finding in words, why, what the component that saw it said, and
 * for a container the last line its instance that ended wrote, with a
 * button to its logs.
 */
export function Diagnostics({
  findings,
  onLogs,
}: {
  findings: readonly Finding[];
  onLogs?: ((choice: FindingLogsChoice) => void) | undefined;
}) {
  return (
    <div className="flex flex-col gap-2">
      {findings.map((finding, index) => (
        <Callout
          key={index}
          tone={finding.tone === "danger" ? "error" : "warn"}
          title={finding.title}
        >
          {finding.detail.length > 0 && (
            <p>
              <Sentence spans={finding.detail} />
            </p>
          )}
          {finding.message !== null && (
            <p className="font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
              {finding.message}
            </p>
          )}
          {finding.logs?.lastLine && (
            <p className="truncate font-mono text-xs text-muted-foreground">
              {finding.logs.lastLine}
            </p>
          )}
          {finding.logs && onLogs && (
            <div className="flex gap-1.5 pt-0.5">
              {finding.logs.previous && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (finding.logs)
                      onLogs({
                        container: finding.logs.container,
                        previous: true,
                      });
                  }}
                >
                  <History aria-hidden />
                  Previous logs
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (finding.logs)
                    onLogs({
                      container: finding.logs.container,
                      previous: false,
                    });
                }}
              >
                <ScrollText aria-hidden />
                Logs
              </Button>
            </div>
          )}
        </Callout>
      ))}
    </div>
  );
}
