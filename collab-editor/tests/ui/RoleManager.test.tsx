// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { RoleManager } from '../../src/ui/RoleManager';
import type { PeerInfo } from '../../src/hooks/useCollabClient';

const emptyPeers = new Map<string, PeerInfo>();

describe('UI Component: RoleManager', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockImplementation(() => Promise.resolve()),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('hides the minting tools when the role is NOT owner', () => {
    const mockClient = { getRole: () => 'editor' };
    render(<RoleManager client={mockClient as any} localSiteId="my-site-id" peers={emptyPeers} />);

    expect(screen.queryByTestId('owner-tools')).not.toBeInTheDocument();
  });

  it('shows the minting tools when the role is owner', () => {
    const mockClient = { getRole: () => 'owner' };
    render(<RoleManager client={mockClient as any} localSiteId="my-site-id" peers={emptyPeers} />);

    expect(screen.getByTestId('owner-tools')).toBeInTheDocument();
  });

  it('disables the mint button when the site ID is empty', () => {
    const mockClient = { getRole: () => 'owner' };
    render(<RoleManager client={mockClient as any} localSiteId="my-site-id" peers={emptyPeers} />);

    const button = screen.getByRole('button', { name: /create token/i });
    expect(button).toBeDisabled();
  });

  it('shows an error message if the server rejects the mint request', async () => {
    const mockMintToken = vi.fn().mockRejectedValue(new Error('Permission denied'));
    const mockClient = { getRole: () => 'owner', mintToken: mockMintToken };
    render(<RoleManager client={mockClient as any} localSiteId="my-site-id" peers={emptyPeers} />);

    fireEvent.change(screen.getByPlaceholderText('Or type Site ID...'), { target: { value: 'bob' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create token/i }));
    });

    expect(screen.getByText('Permission denied')).toBeInTheDocument();
  });

  it('mints token, copies to clipboard, and clears it after 30 seconds', async () => {
    vi.useFakeTimers();

    const mockMintToken = vi.fn().mockResolvedValue('mocked-jwt-token-123');
    const mockClient = { getRole: () => 'owner', mintToken: mockMintToken };

    // Provide charlie as a known peer so the dropdown is populated
    const mockPeers = new Map<string, PeerInfo>([
      ['charlie', { role: 'editor' as any, lastHb: 0 }],
    ]);
    render(<RoleManager client={mockClient as any} localSiteId="my-site-id" peers={mockPeers} />);

    // Two comboboxes: peer selector (first) and role selector (second)
    const dropdowns = screen.getAllByRole('combobox');
    fireEvent.change(dropdowns[0], { target: { value: 'charlie' } });
    fireEvent.change(dropdowns[1], { target: { value: 'viewer' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create token/i }));
    });

    expect(mockMintToken).toHaveBeenCalledWith('charlie', 'viewer');
    expect(screen.getByText('mocked-jwt-token-123')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }));
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('mocked-jwt-token-123');
    expect(screen.getByText('Copied!')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(30000);
    });

    expect(screen.queryByText('mocked-jwt-token-123')).not.toBeInTheDocument();
  });
});
