import { Button, LinkButton } from "@twigo/ui";
import { useReport } from "./useReport";

export function ReportLink({ className }: { className?: string }) {
  const report = useReport();
  return (
    <LinkButton {...(className && { className })} onClick={report}>
      Report…
    </LinkButton>
  );
}

export function ReportButton() {
  const report = useReport();
  return (
    <Button size="sm" variant="outline" onClick={report}>
      Report…
    </Button>
  );
}
