import { Component, type ReactNode } from 'react';
import { DEFAULT_SCENARIO } from '../sim/scenarios.ts';
import { S } from './strings.ts';

export class CrashBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  override state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  reset = () => {
    history.replaceState(null, '', `${location.pathname}#scenario=${DEFAULT_SCENARIO}`);
    this.setState({ crashed: false });
  };

  override render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <>
        <header className="header">
          <div className="brand">
            <h1>{S.app.title}</h1>
          </div>
        </header>
        <div className="notice error" role="alert" data-testid="crash">
          <p>{S.crash.message}</p>
          <button type="button" className="btn" onClick={this.reset}>
            {S.crash.reset}
          </button>
        </div>
      </>
    );
  }
}
