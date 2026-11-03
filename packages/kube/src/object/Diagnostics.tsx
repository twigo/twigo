import type { Finding } from "@twigo/protocol";
import { Callout } from "@twigo/ui";
import { Sentence } from "./values";

/**
 * What is wrong with an object, first in its Overview (ARCHITECTURE 4.3):
 * each finding in words, why, and what the component that saw it said.
 */
export function Diagnostics({ findings }: { findings: readonly Finding[] }) {
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
        </Callout>
      ))}
    </div>
  );
}
