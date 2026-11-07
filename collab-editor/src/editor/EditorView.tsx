import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView as CMEditorView, keymap } from "@codemirror/view";
import { redo } from "@codemirror/commands";
import { basicSetup } from "codemirror";
import { ClientSync, Role } from "collab-sync";
import { CollabBridge } from "../bridge/CollabBridge";

import { collabTheme } from "./theme";
import { remoteCursorsField, updatePresenceEffect } from "./extensions/remoteCursors";
import { readOnlyExtension } from "./extensions/readOnly";
import { SiteId } from "crdt-engine";
import { SelectionPresence } from "../bridge/presence";

export interface EditorViewHandle {
  /** Replace the entire editor content; flows through the bridge as local edits → CRDT ops. */
  setContent: (text: string) => void;
}

interface EditorViewProps {
  client: ClientSync;
  presences: Map<SiteId, SelectionPresence>;
}

export const EditorView = React.forwardRef<EditorViewHandle, EditorViewProps>(
  ({ client, presences }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<CMEditorView | null>(null);
    const [bridge, setBridge] = useState<CollabBridge | null>(null);

    useImperativeHandle(ref, () => ({
      setContent: (text: string) => {
        if (!viewRef.current) return;
        const view = viewRef.current;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
        });
      },
    }), []);

    useEffect(() => {
      if (!containerRef.current) return;

      const newBridge = new CollabBridge(client);
      setBridge(newBridge);

      const updateListener = CMEditorView.updateListener.of((update) => {
        newBridge.onLocalUpdate(update);
      });

      const state = EditorState.create({
        doc: client.replica.getText(),
        extensions: [
          basicSetup,
          // Ctrl+Y / Cmd+Y as an alias for redo (in addition to Ctrl+Shift+Z from basicSetup).
          keymap.of([{ key: "Mod-y", run: redo }]),
          updateListener,
          collabTheme,
          remoteCursorsField,
          readOnlyExtension((client.getRole() ?? "editor") as Role),
        ]
      });

      const view = new CMEditorView({
        state,
        parent: containerRef.current
      });
      viewRef.current = view;

      newBridge.attach(view);

      return () => {
        newBridge.detach();
        view.destroy();
        viewRef.current = null;
      };
    }, [client]);

    useEffect(() => {
      if (!viewRef.current || !bridge) return;
      viewRef.current.dispatch({
        effects: updatePresenceEffect.of({ presences, offsetMap: bridge.offsetMap })
      });
    }, [presences, bridge]);

    return <div ref={containerRef} style={{ border: "1px solid #ccc", height: "100%", minHeight: "400px" }} />;
  }
);
