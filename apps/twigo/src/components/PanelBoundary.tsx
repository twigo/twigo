import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportUnexpectedError } from "@/lib/errors";

interface Props {
  // Names the crashed surface ("Streams & Consumers", "editor tab") in the toast.
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// Contains a render crash to one panel instead of blanking the workbench (the
// root ErrorBoundary stays as the last resort).
export class PanelBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportUnexpectedError(`panel: ${this.props.label}`, error);
    console.error(info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
          <p className="text-xs font-medium">{this.props.label} crashed.</p>
          <pre className="max-w-full overflow-auto rounded-md border border-border bg-muted p-2 text-left font-mono text-[11px]">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null });
            }}
            className="rounded-md border border-input px-2 py-0.5 text-xs hover:bg-accent"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
