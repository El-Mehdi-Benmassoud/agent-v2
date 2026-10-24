import { render } from 'ink';
import React from 'react';
import { App } from './App.js';
import { SessionManager } from '../core/session/SessionManager.js';

/**
 * Mount the TUI app. The config manager is optional: when omitted the TUI
 * reads workspace/model info from the session itself.
 */
export function renderTUI(sessionManager: SessionManager): void {
  render(
    React.createElement(App, { sessionManager }),
    { patchConsole: true, debug: false }
  );
}

export default renderTUI;