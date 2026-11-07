// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { remoteCursorsField, updatePresenceEffect } from '../../src/editor/extensions/remoteCursors';

describe('CM6 Extension: remoteCursors', () => {
  // We mock the CollabBridge's OffsetMap to strictly control exactly
  // where the CRDT nodes map to in the visible text.
  const mockOffsetMap = {
    getVisibleOffsetForNodeId: (nodeId: string) => {
      if (nodeId === 'node-A') return 2;
      if (nodeId === 'node-B') return 5;
      if (nodeId === 'node-C') return 8;
      return null;
    }
  } as any;

  it('renders carets for peers, updates on movement, and unmounts on disconnect', () => {
    // 1. Initialize the headless editor
    const view = new EditorView({
      state: EditorState.create({
        doc: "Hello world this is a test", // 26 chars long
        extensions: [remoteCursorsField]
      })
    });

    // 2. Dispatch 3 peers joining the document
    const presences = new Map([
      ['alice', { head: { nodeId: 'node-A', offsetWithinNode: 0 }, anchor: { nodeId: 'node-A', offsetWithinNode: 0 } }],
      ['bob', { head: { nodeId: 'node-B', offsetWithinNode: 0 }, anchor: { nodeId: 'node-B', offsetWithinNode: 0 } }],
      ['charlie', { head: { nodeId: 'node-C', offsetWithinNode: 0 }, anchor: { nodeId: 'node-C', offsetWithinNode: 0 } }]
    ] as any);

    view.dispatch({
      effects: updatePresenceEffect.of({ presences, offsetMap: mockOffsetMap })
    });

    // CodeMirror widgets are rendered synchronously in headless testing.
    // Our remoteCursors.ts creates a <span> with a "borderLeft" for the caret.
    let carets = view.contentDOM.querySelectorAll('span[style*="border-left"]');
    
    // Assert all 3 peers rendered
    expect(carets.length).toBe(3);

    // 3. Update the presence map: Alice moves, Charlie disconnects
    const updatedPresences = new Map([
      // Alice moved her cursor to a new node
      ['alice', { head: { nodeId: 'node-B', offsetWithinNode: 1 }, anchor: { nodeId: 'node-B', offsetWithinNode: 1 } }],
      // Bob stayed still
      ['bob', { head: { nodeId: 'node-B', offsetWithinNode: 0 }, anchor: { nodeId: 'node-B', offsetWithinNode: 0 } }]
      // Charlie is gone!
    ] as any);

    view.dispatch({
      effects: updatePresenceEffect.of({ presences: updatedPresences, offsetMap: mockOffsetMap })
    });

    // Re-query the DOM
    carets = view.contentDOM.querySelectorAll('span[style*="border-left"]');
    
    // Assert Charlie's caret was unmounted
    expect(carets.length).toBe(2);

    // 4. Everyone disconnects
    view.dispatch({
      effects: updatePresenceEffect.of({ presences: new Map(), offsetMap: mockOffsetMap })
    });

    carets = view.contentDOM.querySelectorAll('span[style*="border-left"]');
    
    // Assert the DOM is completely clean
    expect(carets.length).toBe(0);

    view.destroy();
  });
});