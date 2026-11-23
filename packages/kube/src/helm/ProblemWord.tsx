import { StatusDot } from "@twigo/ui";
import { problemWords } from "./status";

/** What a release row or a History line says in place of its status when its revision cannot be read: the word of the code in the error tone, and why in its tooltip. */
export function ProblemWord({ code }: { code: string }) {
  const { word, why } = problemWords(code);
  return (
    <span
      title={why}
      className="inline-flex items-center gap-1.5 align-top font-semibold text-error"
    >
      <StatusDot tone="error" />
      {word}
    </span>
  );
}
