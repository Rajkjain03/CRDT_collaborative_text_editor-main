import { describe, it, expect } from 'vitest';
import { HistoryStack } from '../../src/undo/HistoryStack';
import { CompensatingOp } from '../../src/undo/compensate';

describe('Undo/Redo: HistoryStack', () => {
  it('returns null when undoing past an empty stack', () => {
    const stack = new HistoryStack();
    expect(stack.canUndo()).toBe(false);
    expect(stack.pop()).toBeNull();
  });

  it('pops items in strict LIFO (Last-In-First-Out) order', () => {
    const stack = new HistoryStack();
    const op1: CompensatingOp = { type: 'undo_delete', targetId: 'node-1' };
    const op2: CompensatingOp = { type: 'undo_insert', text: 'a', afterId: null };

    stack.push(op1);
    stack.push(op2);

    expect(stack.canUndo()).toBe(true);
    expect(stack.pop()).toBe(op2);
    expect(stack.pop()).toBe(op1);
    expect(stack.pop()).toBeNull();
  });

  it('honors the capacity bound by dropping the oldest entry', () => {
    const stack = new HistoryStack(3); 

    stack.push({ type: 'undo_delete', targetId: 'node-1' });
    stack.push({ type: 'undo_delete', targetId: 'node-2' });
    stack.push({ type: 'undo_delete', targetId: 'node-3' });
    
    // Pushing the 4th item should silently drop node-1 out the back
    stack.push({ type: 'undo_delete', targetId: 'node-4' }); 

    expect(stack.pop()?.targetId).toBe('node-4');
    expect(stack.pop()?.targetId).toBe('node-3');
    expect(stack.pop()?.targetId).toBe('node-2');
    
    // node-1 is gone!
    expect(stack.pop()).toBeNull(); 
  });
});