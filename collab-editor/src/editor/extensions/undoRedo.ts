import { keymap } from "@codemirror/view";
import { HistoryStack } from "../../undo/HistoryStack";

/**
 * Keymap extension to hook Cmd-Z / Ctrl-Z to our local CRDT history stack
 */
export const undoRedo = (history: HistoryStack) => keymap.of([
  {
    key: "Mod-z",
    run: (view) => {
      const op = history.pop();
      if (!op) return false;

      // In a full implementation, we'd dispatch the inverse op to the client here
      // For now, it consumes the shortcut.
      console.log("Undo triggered:", op);
      return true;
    }
  }
]);
