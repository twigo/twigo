import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Banner } from "@twigo/ui";
import { ErrorMessage } from "@twigo/workbench";
import { StoppedActions } from "./StoppedActions";
import { isStopped, type ObjectProblem } from "./viewProblem";

/** An object's problem in words with its code as the variant says; an object that is gone has none. */
export function ProblemWords({ problem }: { problem: ObjectProblem }) {
  return problem.error ? (
    <ErrorMessage error={problem.error} message={problem.body} />
  ) : (
    problem.body
  );
}

/**
 * Over what a view still shows of an object that stopped or is gone, why it
 * did, with Reopen and Report… where Twigo's own code stopped it. `lead`
 * names the object when the view holds several.
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
  return (
    <Banner
      tone="warn"
      icon={TriangleAlert}
      title={`${lead}${problem.title}`}
      {...(isStopped(problem) && {
        action: <StoppedActions onReopen={onReopen} />,
      })}
    >
      <ProblemWords problem={problem} /> {children}
    </Banner>
  );
}
