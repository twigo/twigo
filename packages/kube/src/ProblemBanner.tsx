import type { ReactNode } from "react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { Banner } from "@twigo/ui";
import { ErrorBanner, ErrorMessage } from "@twigo/workbench";
import { StoppedActions } from "./StoppedActions";
import { isStopped, type ObjectProblem } from "./viewProblem";

/** An object's problem in words with its code under them; an object that is gone has none. */
export function ProblemWords({ problem }: { problem: ObjectProblem }) {
  return problem.error ? (
    <ErrorMessage error={problem.error} message={problem.body} />
  ) : (
    problem.body
  );
}

/**
 * Over what a view still shows of an object that stopped or is gone, why it
 * did, with Reopen and Report… where Twigo's own code stopped it, which is
 * an error. `lead` names the object when the view holds several.
 */
export function ProblemBanner({
  problem,
  lead = "",
  onReopen,
  children,
}: {
  problem: ObjectProblem;
  lead?: string;
  onReopen?: (() => void) | undefined;
  children?: ReactNode;
}) {
  const title = `${lead}${problem.title}.`;
  if (isStopped(problem)) {
    return (
      <ErrorBanner
        tone="error"
        icon={CircleAlert}
        title={title}
        action={<StoppedActions onReopen={onReopen} />}
        error={problem.error}
        message={problem.body}
      >
        {children}
      </ErrorBanner>
    );
  }
  return (
    <Banner tone="warn" icon={TriangleAlert} title={title}>
      <ProblemWords problem={problem} /> {children}
    </Banner>
  );
}
