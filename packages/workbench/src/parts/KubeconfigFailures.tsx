import { FileWarning } from "lucide-react";
import type { CatalogFailure } from "@twigo/protocol";
import { EmptyState } from "@twigo/ui";
import { ErrorMessage } from "../ErrorMessage";

/** What the start says when every kubeconfig file failed, so no context is listed: which files, and why each. */
export function KubeconfigFailures({
  failures,
}: {
  failures: readonly CatalogFailure[];
}) {
  return (
    <EmptyState
      icon={FileWarning}
      title={
        failures.length === 1
          ? "The kubeconfig file could not be read"
          : `None of the ${String(failures.length)} kubeconfig files could be read`
      }
      className="h-full bg-editor"
    >
      <p className="max-w-md">
        Twigo lists the contexts again when a file changes.
      </p>
      <ul className="mt-2 grid max-w-xl gap-3">
        {failures.map(({ source, error }) => (
          <li key={source}>
            <span className="block font-mono text-content">{source}</span>
            <ErrorMessage error={error} className="justify-center" />
          </li>
        ))}
      </ul>
    </EmptyState>
  );
}
