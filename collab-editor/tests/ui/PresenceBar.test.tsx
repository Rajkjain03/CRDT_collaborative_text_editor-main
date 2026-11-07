// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PresenceBar } from '../../src/ui/PresenceBar';
import { SelectionPresence } from '../../src/bridge/presence';

describe('UI Component: PresenceBar', () => {
  afterEach(() => {
    cleanup(); // Keep the DOM clean between tests!
  });

  // Mock presence data
  const mockPresences = new Map<string, SelectionPresence>([
    ['alice', { start: 0, end: 0 }],
    ['bob', { start: 5, end: 10 }],
    ['charlie', { start: 1, end: 1 }]
  ]);

  it('renders the correct number of avatars for current peers', () => {
    render(<PresenceBar presences={mockPresences} />);
    
    // Should render three avatars
    expect(screen.getByText(/alice/i)).toBeInTheDocument();
    expect(screen.getByText(/bob/i)).toBeInTheDocument();
    expect(screen.getByText(/charlie/i)).toBeInTheDocument();
  });

  it('shows a "you" indicator on the local site\'s avatar', () => {
    render(<PresenceBar presences={mockPresences} localSiteId="bob" />);
    
    const bobAvatar = screen.getByTestId('avatar-bob');
    const youIndicator = screen.getByTestId('you-indicator');
    
    expect(bobAvatar).toContainElement(youIndicator);
    expect(youIndicator).toHaveTextContent('(You)');
    
    // Alice and Charlie should NOT have the "(You)" indicator
    expect(screen.getByTestId('avatar-alice')).not.toContainHTML('(You)');
    expect(screen.getByTestId('avatar-charlie')).not.toContainHTML('(You)');
  });

  it('assigns deterministic colors per siteId', () => {
    const { rerender } = render(<PresenceBar presences={new Map([['alice', { start: 0, end: 0 }]])} />);
    
    // Get Alice's color on the first render
    const aliceAvatarFirstRender = screen.getByTestId('avatar-alice');
    const firstColor = aliceAvatarFirstRender.style.background;

    // Wipe the presences, add bob, then add alice back to simulate sites joining/leaving
    const updatedPresences = new Map<string, SelectionPresence>([
      ['bob', { start: 0, end: 0 }],
      ['alice', { start: 1, end: 1 }]
    ]);

    rerender(<PresenceBar presences={updatedPresences} />);

    // Get Alice's color on the second render
    const aliceAvatarSecondRender = screen.getByTestId('avatar-alice');
    const secondColor = aliceAvatarSecondRender.style.background;

    // The color must be identical across renders
    expect(firstColor).toBe(secondColor);
    
    // Bob should have a strictly different color than Alice
    const bobAvatar = screen.getByTestId('avatar-bob');
    expect(bobAvatar.style.background).not.toBe(firstColor);
  });
});