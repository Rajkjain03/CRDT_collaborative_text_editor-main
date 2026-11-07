// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DocumentTitle } from '../../src/ui/DocumentTitle';

describe('UI Component: DocumentTitle', () => {
  let mockClient: any;

  beforeEach(() => {
    vi.useFakeTimers();

    // replica.lww is a Map-like object with a get() method
    mockClient = {
      replica: {
        lww: new Map([['title', 'Initial Remote Title']])
      },
      setMeta: vi.fn(),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('loads the initial remote title correctly', () => {
    render(<DocumentTitle client={mockClient} metaVersion={0} />);
    const input = screen.getByDisplayValue('Initial Remote Title');
    expect(input).toBeInTheDocument();
  });

  it('updates the field when a remote update occurs (metaVersion bump)', () => {
    const { rerender } = render(<DocumentTitle client={mockClient} metaVersion={0} />);

    // Simulate remote update: update the LWW store, then bump metaVersion
    act(() => {
      mockClient.replica.lww.set('title', 'Alice updated this');
    });
    rerender(<DocumentTitle client={mockClient} metaVersion={1} />);

    expect(screen.getByDisplayValue('Alice updated this')).toBeInTheDocument();
  });

  it('debounces local typing: 10 keystrokes = 1 network broadcast', () => {
    render(<DocumentTitle client={mockClient} metaVersion={0} />);
    const input = screen.getByDisplayValue('Initial Remote Title');

    fireEvent.change(input, { target: { value: 'H' } });
    fireEvent.change(input, { target: { value: 'He' } });
    fireEvent.change(input, { target: { value: 'Hel' } });
    fireEvent.change(input, { target: { value: 'Hell' } });
    fireEvent.change(input, { target: { value: 'Hello' } });

    expect(input).toHaveValue('Hello');
    expect(mockClient.setMeta).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(mockClient.setMeta).toHaveBeenCalledTimes(1);
    expect(mockClient.setMeta).toHaveBeenCalledWith('title', 'Hello');
  });

  it('handles an empty title gracefully', () => {
    render(<DocumentTitle client={mockClient} metaVersion={0} />);
    const input = screen.getByDisplayValue('Initial Remote Title');

    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveValue('');

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(mockClient.setMeta).toHaveBeenCalledWith('title', '');
  });
});
