// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../../src/ui/App';
import * as useCollabClientHook from '../../src/hooks/useCollabClient';

// 1. Mock the heavy CodeMirror Editor so it doesn't crash JSDOM
vi.mock('../../src/editor/EditorView', () => ({
  EditorView: () => <div data-testid="mock-editor">CodeMirror Editor</div>
}));

// 2. Mock the Presence hook
vi.mock('../../src/hooks/usePresence', () => ({
  usePresence: () => new Map()
}));

describe('UI Component: App', () => {
  let mockClient: any;

  beforeEach(() => {
    // Default client mock
    mockClient = {
      getConnectionState: vi.fn().mockReturnValue('connected'),
      getRole: vi.fn().mockReturnValue('owner'),
      replica: { lww: new Map() },
      onMetaChanged: undefined,
      setMeta: vi.fn()
    };

    // Intercept the useCollabClient hook
    vi.spyOn(useCollabClientHook, 'useCollabClient').mockImplementation((site, url, token, connected) => {
      return connected ? mockClient : null;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the initial connect form when not connected', () => {
    render(<App />);
    expect(screen.getByPlaceholderText('Paste Token here...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect/i })).toBeInTheDocument();
  });

  it('shows a loading state while connect() is pending', () => {
    mockClient.getConnectionState.mockReturnValue('connecting');
    render(<App />);
    
    // Click connect to trigger the hook
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    
    expect(screen.getByText('Connecting to Relay Server...')).toBeInTheDocument();
  });

  it('shows an error UI with a retry button on connection failure', () => {
    mockClient.getConnectionState.mockReturnValue('disconnected');
    render(<App />);
    
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    
    expect(screen.getByText('Connection Failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders top-level layout (editor, title, presence, status) and RoleManager for Owner', () => {
    mockClient.getConnectionState.mockReturnValue('connected');
    mockClient.getRole.mockReturnValue('owner'); // Set role to Owner
    render(<App />);
    
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    
    // Verify Layout Components
    expect(screen.getByTestId('mock-editor')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Untitled Document')).toBeInTheDocument();
    expect(screen.getByText('Session Info')).toBeInTheDocument(); // Role Manager is visible
  });

  it('shows basic info but hides owner tools when role is Viewer', () => {
    mockClient.getConnectionState.mockReturnValue('connected');
    mockClient.getRole.mockReturnValue('viewer'); 
    render(<App />);
    
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    
    // Viewer SHOULD see the basic Session Info block now
    expect(screen.getByText('Session Info')).toBeInTheDocument();
    
    // But the owner-specific tools should still be hidden
    expect(screen.queryByTestId('owner-tools')).not.toBeInTheDocument();
  });
});