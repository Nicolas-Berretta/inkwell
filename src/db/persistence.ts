/**
 * Application-wide persistence singletons and tab-lifecycle flushing.
 *
 * Components that buffer changes (debounced text edits, the engine's camera
 * timer) register a "flusher"; when the tab is hidden or closed every flusher
 * runs first and then the write queue is written out, so nothing typed or
 * drawn is lost on a normal close or reload.
 */
import { AppDatabase } from './database';
import { WriteQueue } from './writeQueue';

let errorHandler: (error: unknown) => void = (error) => console.error('Failed to save changes', error);

/** Routes background write failures to the UI. */
export function setPersistenceErrorHandler(handler: (error: unknown) => void): void {
  errorHandler = handler;
}

export const db = new AppDatabase();
export const writeQueue = new WriteQueue(db, 250, (error) => errorHandler(error));

const flushers = new Set<() => void>();

/** Registers a callback that pushes buffered changes into the write queue. Returns an unregister function. */
export function registerFlusher(flusher: () => void): () => void {
  flushers.add(flusher);
  return () => {
    flushers.delete(flusher);
  };
}

/** Runs every flusher, then writes all pending changes to IndexedDB. */
export function flushAll(): Promise<void> {
  for (const flusher of [...flushers]) flusher();
  return writeQueue.flush();
}

/** Flushes whenever the tab is hidden, frozen or unloaded. Returns an uninstall function. */
export function installLifecycleFlush(): () => void {
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') void flushAll();
  };
  const onPageHide = () => {
    void flushAll();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('beforeunload', onPageHide);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('beforeunload', onPageHide);
  };
}
