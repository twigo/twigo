import { Component, type ErrorInfo, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { cn, EmptyState } from "@twigo/ui";

export interface Crash {
  readonly label: string;
  readonly error: Error;
  readonly retry: () => void;
}

interface Props {
  label: string;
  children: ReactNode;
  /** Replaces the default panel-sized message, for parts too small to hold it. */
  fallback?: (crash: Crash) => ReactNode;
  onCrash?: (error: Error) => void;
}

interface State {
  error: Error | undefined;
}

/** Contains a render crash to one part, view or editor, from legacy `PanelBoundary`. */
export class PanelBoundary extends Component<Props, State> {
  override state: State = { error: undefined };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.label} crashed`, error, info.componentStack);
    this.props.onCrash?.(error);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const crash: Crash = {
      label: this.props.label,
      error,
      retry: () => {
        this.setState({ error: undefined });
      },
    };
    if (this.props.fallback) return this.props.fallback(crash);
    return (
      <EmptyState
        icon={CircleAlert}
        variant="error"
        title={`${crash.label} crashed`}
        className="h-full"
        action={{ label: "Try again", onClick: crash.retry }}
      >
        <pre className="max-w-full overflow-auto rounded-md border border-border bg-muted p-2 text-left font-mono text-[11px]">
          {error.message}
        </pre>
      </EmptyState>
    );
  }
}

/** A crashed bar or rail: its frame stays, with the message in one line or, `iconOnly`, in a tooltip. */
export function PartCrash({
  crash,
  className,
  iconOnly = false,
}: {
  crash: Crash;
  className?: string;
  iconOnly?: boolean;
}) {
  const message = `${crash.label} crashed: ${crash.error.message}`;
  return (
    <div
      role="alert"
      title={message}
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1.5 overflow-hidden text-xs text-error",
        className,
      )}
    >
      <button
        type="button"
        aria-label={iconOnly ? `${message}. Try again` : "Try again"}
        onClick={crash.retry}
        className="flex shrink-0 items-center gap-1.5 rounded-sm hover:underline"
      >
        <CircleAlert className="size-3.5 shrink-0" />
        {!iconOnly && <span className="truncate">{crash.label} crashed</span>}
      </button>
    </div>
  );
}
