import { errorParts, type ErrorMessageProps } from "./errorParts";

/**
 * An error's message with its code under it as a quiet line, and Copy
 * details. `message` says it in other words than the error's own, `lead` what
 * the message belongs to: `Cannot open the pod in dev: `.
 */
export function ErrorMessage(props: ErrorMessageProps) {
  const { words, details } = errorParts(props);
  return (
    <>
      {words}
      {details}
    </>
  );
}
