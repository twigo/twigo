import { Eye, EyeOff } from "lucide-react";
import { Button } from "@twigo/ui";

/** What hides a value of a Secret or of a release until a Reveal: a ghost eye that reveals it, and once it shows, hides it. */
export function RevealButton({
  label,
  showing,
  loading = false,
  onClick,
}: {
  /** What it reveals, for its name: `password`. */
  label: string;
  /** Whether the value shows, which the button then hides. */
  showing: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={`${showing ? "Hide" : "Reveal"} ${label}`}
      tooltip={showing ? "Hide" : "Reveal"}
      isLoading={loading}
      onClick={onClick}
    >
      {showing ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
    </Button>
  );
}
