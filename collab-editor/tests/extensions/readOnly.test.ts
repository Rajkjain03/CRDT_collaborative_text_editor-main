// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { readOnlyExtension } from '../../src/editor/extensions/readOnly';

describe('CM6 Extension: readOnly', () => {
  it('sets the readOnly facet to true when role is Viewer', () => {
    const state = EditorState.create({
      extensions: [readOnlyExtension('viewer')]
    });
    
    // The facet should literally evaluate to true
    expect(state.facet(EditorState.readOnly)).toBe(true);
  });

  it('sets the readOnly facet to false when role is Editor or Owner', () => {
    const editorState = EditorState.create({ extensions: [readOnlyExtension('editor')] });
    expect(editorState.facet(EditorState.readOnly)).toBe(false);

    const ownerState = EditorState.create({ extensions: [readOnlyExtension('owner')] });
    expect(ownerState.facet(EditorState.readOnly)).toBe(false);
  });

  it('flips the facet and DOM contenteditable when transitioning Viewer -> Editor', () => {
    // We use a Compartment to dynamically swap the extension, exactly how 
    // a React wrapper would reconfigure the editor on a role change.
    const roleCompartment = new Compartment();
    
    const view = new EditorView({
      state: EditorState.create({
        extensions: [roleCompartment.of(readOnlyExtension('viewer'))]
      })
    });

    // 1. Initial State: Viewer
    expect(view.state.facet(EditorState.readOnly)).toBe(true);
    // CodeMirror enforces read-only by physically disabling contenteditable in the DOM
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('false');

    // 2. Transition: Demote to Editor
    view.dispatch({
      effects: roleCompartment.reconfigure(readOnlyExtension('editor'))
    });

    // 3. New State: Editor
    expect(view.state.facet(EditorState.readOnly)).toBe(false);
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('true');
    
    view.destroy();
  });
});