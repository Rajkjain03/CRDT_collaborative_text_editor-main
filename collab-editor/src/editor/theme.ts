import { EditorView } from "@codemirror/view";

/**
 * Editor styling tokens for Phase 3
 */
export const collabTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "14px",
    fontFamily: "monospace"
  },
  ".cm-content": {
    padding: "16px 24px"
  }
});
