import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm font-medium">Something went wrong.</p>
          <pre className="max-w-lg overflow-auto rounded-md border border-border bg-muted p-2 text-left font-mono text-xs">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null });
            }}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
