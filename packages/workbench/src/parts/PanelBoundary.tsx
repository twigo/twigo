import { Component, type ErrorInfo, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { EmptyState } from "@twigo/ui";

interface Props {
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | undefined;
}

/** Contains a render crash to one view or editor, from legacy `PanelBoundary`. */
export class PanelBoundary extends Component<Props, State> {
  override state: State = { error: undefined };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.label} crashed`, error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <EmptyState
        icon={CircleAlert}
        variant="error"
        title={`${this.props.label} crashed`}
        className="h-full"
        action={{
          label: "Try again",
          onClick: () => {
            this.setState({ error: undefined });
          },
        }}
      >
        <pre className="max-w-full overflow-auto rounded-md border border-border bg-muted p-2 text-left font-mono text-[11px]">
          {error.message}
        </pre>
      </EmptyState>
    );
  }
}
