import { useEffect } from 'react';
import { CanvasView } from './components/CanvasView';
import { ConfirmDialog } from './components/ConfirmDialog';
import { EmptyState } from './components/EmptyState';
import { Sidebar } from './components/Sidebar';
import { Toast } from './components/Toast';
import { Toolbar } from './components/Toolbar';
import { TopBar } from './components/TopBar';
import { installLifecycleFlush } from './db/persistence';
import { useCanvasClipboard } from './hooks/useCanvasClipboard';
import { useToolShortcuts } from './hooks/useToolShortcuts';
import { useAppStore } from './store/appStore';

export function App() {
  const status = useAppStore((s) => s.status);
  const errorMessage = useAppStore((s) => s.errorMessage);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const hasPage = useAppStore((s) => s.activePageId !== null);

  useEffect(() => {
    void useAppStore.getState().init();
    return installLifecycleFlush();
  }, []);

  useToolShortcuts();
  useCanvasClipboard();

  if (status === 'loading') {
    return (
      <div className="app-splash" role="status">
        Opening your notebooks…
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="app-splash" role="alert">
        <strong>Inkwell could not open its local database.</strong>
        <span>{errorMessage}</span>
        <span>Check that this browser allows site data (IndexedDB) and reload the page.</span>
      </div>
    );
  }

  return (
    <div className="app" data-sidebar={sidebarCollapsed ? 'collapsed' : 'open'}>
      <Sidebar />
      <main className="workspace">
        <TopBar />
        <div className="canvas-area">
          <CanvasView />
          {hasPage ? <Toolbar /> : <EmptyState />}
        </div>
      </main>
      <ConfirmDialog />
      <Toast />
    </div>
  );
}
