// /app/src/components/ErrorBoundary.tsx
//
// Global React error boundary. Catches unhandled component errors and shows
// a recovery screen (with the error message) instead of a blank page.

import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-sh-linen flex items-center justify-center p-8">
          <div className="bg-white rounded-xl border border-sh-gray/20 shadow-sm p-8 max-w-md w-full text-center space-y-4">
            <p className="text-sh-gold text-sm font-semibold uppercase tracking-widest font-serif">
              Something went wrong
            </p>
            <p className="text-sh-black font-serif text-lg">An unexpected error occurred.</p>
            <p className="text-sh-gray text-sm font-sans">{this.state.error.message}</p>
            <div className="flex gap-3 justify-center mt-2">
              <button
                onClick={() => {
                  this.setState({ error: null });
                  globalThis.location.reload();
                }}
                className="px-6 py-2.5 bg-sh-blue text-white rounded-lg text-sm font-semibold font-sans hover:bg-sh-black transition-colors"
              >
                Reload Page
              </button>
              <button
                onClick={() => {
                  this.setState({ error: null });
                  globalThis.location.href = "/";
                }}
                className="px-6 py-2.5 border border-sh-gray/30 text-sh-gray rounded-lg text-sm font-semibold font-sans hover:border-sh-black hover:text-sh-black transition-colors"
              >
                Go to Home
              </button>
            </div>
            <p className="text-sh-gray/60 text-xs font-sans pt-2">
              If this keeps happening, use the feedback button to report it.
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
