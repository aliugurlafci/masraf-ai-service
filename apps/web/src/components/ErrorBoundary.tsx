import { Component } from 'react';
import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Changing the key (e.g. the location) resets the boundary. */
  resetKey?: string;
}

interface State {
  error: Error | null;
  resetKey: string | undefined;
}

/** Catches render errors so one broken view never blanks the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) {
      return { error: null, resetKey: props.resetKey };
    }
    return null;
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <section className="error-screen" role="alert">
          <h1>Something went wrong</h1>
          <p>This view failed to render. The rest of the application keeps working.</p>
          <pre className="error-stack">{this.state.error.message}</pre>
          <p>
            <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
              Try again
            </button>{' '}
            <button type="button" className="btn btn-ghost" onClick={() => window.location.reload()}>
              Reload page
            </button>
          </p>
        </section>
      );
    }
    return this.props.children;
  }
}
