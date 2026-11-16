/** Bounded undo/redo stack. Generic and DOM-free; the engine decides what an entry means. */
export class HistoryStack<T> {
  private readonly undoStack: T[] = [];
  private readonly redoStack: T[] = [];

  constructor(private readonly limit = 200) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Records a newly performed action. Any redo history is discarded. */
  push(entry: T): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Returns the entry to revert, moving it to the redo stack. */
  undo(): T | undefined {
    const entry = this.undoStack.pop();
    if (entry !== undefined) this.redoStack.push(entry);
    return entry;
  }

  /** Returns the entry to re-apply, moving it back to the undo stack. */
  redo(): T | undefined {
    const entry = this.redoStack.pop();
    if (entry !== undefined) this.undoStack.push(entry);
    return entry;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
