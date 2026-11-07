import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Role } from "collab-sync";

/**
 * Returns a configured EditorState extension that completely disables the editor
 * if the user's role is 'viewer'.
 */
export function readOnlyExtension(role: Role) {
  const isViewer = role === "viewer";
  
  return [
    // 1. Prevents any state transactions from being applied
    EditorState.readOnly.of(isViewer),
    // 2. Physically disables the DOM contenteditable attribute
    EditorView.editable.of(!isViewer) 
  ];
}