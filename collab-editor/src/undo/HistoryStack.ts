import { CompensatingOp } from "./compensate";

export class HistoryStack {
  private stack: CompensatingOp[] = [];
  private capacity: number;

  constructor(capacity = 100) {
    this.capacity = capacity;
  }

  // This is the method the test is complaining about!
  canUndo(): boolean {
    return this.stack.length > 0;
  }

  push(op: CompensatingOp) {
    this.stack.push(op);
    if (this.stack.length > this.capacity) {
      this.stack.shift();
    }
  }

  pop(): CompensatingOp | null {
    return this.stack.pop() || null;
  }

  clear() {
    this.stack = [];
  }
}