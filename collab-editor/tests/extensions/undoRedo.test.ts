// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undoRedo } from '../../src/editor/extensions/undoRedo';
import { HistoryStack } from '../../src/undo/HistoryStack';

describe('CM6 Extension: undoRedo', () => {
  it('consumes Cmd-Z / Ctrl-Z shortcut and pops the history stack', () => {
    const history = new HistoryStack();
    history.push({ type: 'undo_delete', targetId: 'mock-node' });
    
    const popSpy = vi.spyOn(history, 'pop');

    const view = new EditorView({
      state: EditorState.create({
        extensions: [undoRedo(history)]
      })
    });

    const event = new KeyboardEvent('keydown', { 
      key: 'z', 
      ctrlKey: true, 
      bubbles: true 
    });
    view.contentDOM.dispatchEvent(event);

    expect(popSpy).toHaveBeenCalledTimes(1);
    
    view.destroy();
  });

  it('does nothing silently if the stack is empty', () => {
    const history = new HistoryStack();
    const popSpy = vi.spyOn(history, 'pop');

    const view = new EditorView({
      state: EditorState.create({
        extensions: [undoRedo(history)]
      })
    });

    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true });
    view.contentDOM.dispatchEvent(event);

    expect(popSpy).toHaveBeenCalledTimes(1);
    
    view.destroy();
  });
});