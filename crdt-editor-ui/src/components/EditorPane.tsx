import { useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, historyKeymap, history } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';

// Marker effect to distinguish remote changes from local edits
const remoteUpdate = StateEffect.define<null>();

export type EditorChange = {
  from: number;
  toA: number;
  inserted: string;
};

export type EditorPaneHandle = {
  applyRemoteText: (newText: string) => void;
};

type EditorPaneProps = {
  accentColor: string;
  onLocalChange: (changes: EditorChange[]) => void;
  disabled?: boolean;
};

const EditorPane = forwardRef<EditorPaneHandle, EditorPaneProps>(
  ({ accentColor, onLocalChange, disabled }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const isRemoteRef = useRef(false);
    const onLocalChangeRef = useRef(onLocalChange);

    // Keep the ref always pointing to the latest callback
    useEffect(() => {
      onLocalChangeRef.current = onLocalChange;
    }, [onLocalChange]);

    useImperativeHandle(ref, () => ({
      applyRemoteText: (newText: string) => {
        const view = viewRef.current;
        if (!view) return;
        const currentText = view.state.doc.toString();
        if (currentText === newText) return;

        isRemoteRef.current = true;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: newText },
          effects: [remoteUpdate.of(null)],
        });
        isRemoteRef.current = false;
      },
    }));

    useEffect(() => {
      if (!containerRef.current) return;

      const updateListener = EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        // Skip remote-originated changes
        for (const tr of update.transactions) {
          for (const effect of tr.effects) {
            if (effect.is(remoteUpdate)) return;
          }
        }
        if (isRemoteRef.current) return;

        // Collect local changes
        const changes: EditorChange[] = [];
        update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          changes.push({ from: fromA, toA, inserted: inserted.toString() });
        });
        if (changes.length > 0) {
          onLocalChangeRef.current(changes);
        }
      });

      const customTheme = EditorView.theme({
        '&': {
          height: '100%',
          fontSize: '14px',
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        },
        '.cm-content': {
          caretColor: accentColor,
          padding: '12px 0',
        },
        '&.cm-focused .cm-cursor': {
          borderLeftColor: accentColor,
          borderLeftWidth: '2px',
        },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
          backgroundColor: `${accentColor}30`,
        },
        '.cm-activeLine': {
          backgroundColor: `${accentColor}08`,
        },
        '.cm-activeLineGutter': {
          backgroundColor: `${accentColor}10`,
        },
        '.cm-gutters': {
          backgroundColor: 'transparent',
          borderRight: '1px solid rgba(255,255,255,0.06)',
          color: 'rgba(255,255,255,0.2)',
        },
        '.cm-scroller': {
          overflow: 'auto',
        },
      });

      const startState = EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          javascript(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          oneDark,
          customTheme,
          updateListener,
          EditorView.editable.of(!disabled),
        ],
      });

      const view = new EditorView({
        state: startState,
        parent: containerRef.current,
      });

      viewRef.current = view;

      return () => {
        view.destroy();
        viewRef.current = null;
      };
    }, []);

    return (
      <div
        ref={containerRef}
        className="editor-container"
        style={{ borderColor: `${accentColor}40` }}
      />
    );
  }
);

EditorPane.displayName = 'EditorPane';
export default EditorPane;
