import { Annotation, Transaction } from "@codemirror/state";
import { EditorView, ViewUpdate } from "@codemirror/view";
import { type ClientSync } from "collab-sync";
import { OffsetMap } from "./offsetMap";
import { broadcastPresence } from "./presence";

export const remoteAnnotation = Annotation.define<boolean>();

/**
 * Compute the minimal single-range change between two strings.
 * Finds the longest common prefix and suffix, then returns a change
 * that only touches the differing middle. This lets CM6 remap cursors
 * through remote ops instead of resetting them on every update.
 */
function minimalChange(
  oldText: string,
  newText: string,
): { from: number; to: number; insert: string } {
  let start = 0;
  while (
    start < oldText.length &&
    start < newText.length &&
    oldText[start] === newText[start]
  ) start++;

  let endOld = oldText.length;
  let endNew = newText.length;
  while (
    endOld > start &&
    endNew > start &&
    oldText[endOld - 1] === newText[endNew - 1]
  ) { endOld--; endNew--; }

  return { from: start, to: endOld, insert: newText.slice(start, endNew) };
}

export class CollabBridge {
  private client: ClientSync;
  private view: EditorView | null = null;
  public offsetMap: OffsetMap;
  private isApplyingRemote = false;

  constructor(client: ClientSync) {
    this.client = client;
    this.offsetMap = new OffsetMap(client.replica);
    this.client.onOpsApplied = (_ops) => {
      this.applyRemoteOps();
    };
  }

  attach(view: EditorView) {
    this.view = view;
    const text = this.client.replica.getText();
    const oldText = view.state.doc.toString();
    if (oldText !== text) {
      this.isApplyingRemote = true;
      const change = minimalChange(oldText, text);
      view.dispatch({
        changes: change,
        annotations: [remoteAnnotation.of(true), Transaction.addToHistory.of(false)],
      });
      this.isApplyingRemote = false;
    }
  }

  detach() {
    this.view = null;
  }

  onLocalUpdate(update: ViewUpdate) {
    if (this.isApplyingRemote) return;

    if (update.selectionSet && this.view) {
      const selection = update.state.selection.main;
      broadcastPresence(this.client, this.offsetMap, selection.anchor, selection.head);
    }

    if (!update.docChanged) return;
    if (update.transactions.some(tr => tr.annotation(remoteAnnotation))) return;

    const changes: Array<{from: number, to: number, text: string}> = [];
    update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ from: fromA, to: toA, text: inserted.toString() });
    });

    for (let i = changes.length - 1; i >= 0; i--) {
      const { from, to, text } = changes[i];
      for (let j = to - 1; j >= from; j--) this.client.delete(j);
      for (let j = 0; j < text.length; j++) this.client.insert(from + j, text[j]);
    }
  }

  private applyRemoteOps() {
    if (!this.view) return;
    this.isApplyingRemote = true;
    const newText = this.client.replica.getText();
    const oldText = this.view.state.doc.toString();
    if (oldText !== newText) {
      const change = minimalChange(oldText, newText);
      this.view.dispatch({
        changes: change,
        // Exclude from CM6 undo history so Ctrl+Z only reverts local edits.
        annotations: [remoteAnnotation.of(true), Transaction.addToHistory.of(false)],
        userEvent: "remote",
      });
    }
    this.isApplyingRemote = false;
  }
}