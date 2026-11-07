// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ConnectionStatus } from '../../src/ui/ConnectionStatus';

describe('UI Component: ConnectionStatus', () => {
  // CRITICAL FIX: Manually wipe the DOM after every test so they don't stack up!
  afterEach(() => {
    cleanup();
  });

  it('renders the "connected" state correctly with green color', () => {
    render(<ConnectionStatus status="connected" />);
    expect(screen.getByText('Online')).toBeInTheDocument();
    
    const indicator = screen.getByTestId('status-indicator');
    expect(indicator).toHaveStyle('background-color: rgb(0, 128, 0)'); // Using CSS string
  });

  it('renders the "disconnected" state correctly with red color', () => {
    render(<ConnectionStatus status="disconnected" />);
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
    
    const indicator = screen.getByTestId('status-indicator');
    expect(indicator).toHaveStyle('background-color: rgb(255, 0, 0)');
  });

  it('renders the "connecting" state correctly with yellow color', () => {
    render(<ConnectionStatus status="connecting" />);
    expect(screen.getByText('Connecting...')).toBeInTheDocument();
    
    const indicator = screen.getByTestId('status-indicator');
    expect(indicator).toHaveStyle('background-color: rgb(255, 255, 0)');
  });

  it('renders the "reconnecting" state and shows attempt count', () => {
    render(<ConnectionStatus status="reconnecting" attemptCount={3} />);
    expect(screen.getByText('Reconnecting (Attempt 3)...')).toBeInTheDocument();
    
    const indicator = screen.getByTestId('status-indicator');
    expect(indicator).toHaveStyle('background-color: rgb(255, 165, 0)');
  });
});