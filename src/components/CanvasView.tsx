import type { DragEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContextMenuRequest } from '../canvas/CanvasEngine';
import { CanvasEngine } from '../canvas/CanvasEngine';
import { db, registerFlusher, writeQueue } from '../db/persistence';
import { loadImages, loadStrokes } from '../db/repositories';
import { useAppStore } from '../store/appStore';
import { imageFilesOf, insertImages, insertPickedImages, registerImagePicker } from '../store/canvasActions';
import { setActiveEngine } from '../store/engineRegistry';
import { IMAGE_MIME_TYPES } from '../types';
import { CanvasContextMenu } from './CanvasContextMenu';
import { TextLayer } from './TextLayer';

/**
 * Mounts the imperative canvas engine and feeds it coarse state. This
 * component renders once per page / tool / theme change, never per pointer
 * move: all drawing, panning and zooming happens inside the engine.
 */
export function CanvasView() {
  const stageRef = useRef<HTMLDivElement>(null);
  const backgroundRef = useRef<HTMLCanvasElement>(null);
  const inkRef = useRef<HTMLCanvasElement>(null);
  const highlightRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const imageLayerRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const engineRef = useRef<CanvasEngine | null>(null);
  const [menu, setMenu] = useState<ContextMenuRequest | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const activePageId = useAppStore((s) => s.activePageId);
  const tools = useAppStore((s) => s.tools);
  const theme = useAppStore((s) => s.theme);
  const background = useAppStore((s) => s.pages.find((p) => p.id === s.activePageId)?.background ?? 'blank');

  useEffect(() => {
    const stage = stageRef.current;
    const backgroundCanvas = backgroundRef.current;
    const ink = inkRef.current;
    const highlight = highlightRef.current;
    const live = liveRef.current;
    const textLayer = textLayerRef.current;
    const imageLayer = imageLayerRef.current;
    if (!stage || !backgroundCanvas || !ink || !highlight || !live || !textLayer || !imageLayer) return;

    const initial = useAppStore.getState();
    const engine = new CanvasEngine(
      { stage, background: backgroundCanvas, ink, highlight, live, textLayer, imageLayer },
      {
        onStrokesPut: (records) => {
          for (const record of records) writeQueue.put('strokes', record);
        },
        onStrokesDelete: (ids) => {
          for (const id of ids) writeQueue.delete('strokes', id);
        },
        onCameraSettled: (pageId, camera) => useAppStore.getState().saveCamera(pageId, camera),
        onTextRequest: (pageId, x, y) => useAppStore.getState().addTextBox(pageId, x, y),
        onHistoryChange: (canUndo, canRedo) => useAppStore.getState().setHistoryState(canUndo, canRedo),
        onImagesPut: (records) => {
          for (const record of records) writeQueue.put('images', record);
        },
        onImageBlobsPut: (entries) => {
          for (const entry of entries) writeQueue.put('imageBlobs', { id: entry.record.id, data: entry.blob });
        },
        onImagesDelete: (ids) => {
          for (const id of ids) {
            writeQueue.delete('images', id);
            writeQueue.delete('imageBlobs', id);
          }
        },
        onTextBoxesPut: (records) => useAppStore.getState().putTextBoxes(records),
        onTextBoxesDelete: (ids) => {
          for (const id of ids) useAppStore.getState().removeTextBox(id);
        },
        onContextMenu: setMenu,
      },
      { theme: initial.theme, settings: initial.tools },
    );
    engineRef.current = engine;
    setActiveEngine(engine);
    const unregister = registerFlusher(() => engine.flushCamera());
    registerImagePicker({ open: () => imageInputRef.current?.click() });
    return () => {
      unregister();
      registerImagePicker(null);
      setActiveEngine(null);
      engineRef.current = null;
      engine.destroy();
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setSettings(tools);
  }, [tools]);

  useEffect(() => {
    engineRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    engineRef.current?.setBackground(background);
  }, [background]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    // Blank the surface right away so ink from the previous page never shows under the new one.
    engine.loadPage(null, []);
    setMenu(null);
    if (!activePageId) return;
    let cancelled = false;
    writeQueue
      .flush()
      .then(() => Promise.all([loadStrokes(db, activePageId), loadImages(db, activePageId)]))
      .then(([strokes, images]) => {
        if (cancelled) return;
        const page = useAppStore.getState().pages.find((p) => p.id === activePageId);
        if (page) engine.loadPage(page, strokes, images);
      })
      .catch((error: unknown) => {
        console.error('Failed to load page content', error);
        useAppStore.getState().notify('The ink and images on this page could not be loaded.', 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [activePageId]);

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    // Accepting the drag is what makes the browser deliver the drop instead of opening the file.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    const engine = engineRef.current;
    if (!engine || !activePageId) return;
    const images = imageFilesOf(e.dataTransfer.files);
    if (images.length === 0) {
      useAppStore.getState().notify('Only PNG, JPEG, WebP, GIF, BMP and AVIF images can be dropped here.', 'error');
      return;
    }
    void insertImages(images, engine.clientToWorld(e.clientX, e.clientY));
  };

  return (
    <>
      <div className="stage" ref={stageRef} onDragOver={onDragOver} onDrop={onDrop}>
        <canvas className="stage-canvas stage-background" ref={backgroundRef} />
        <div className="image-layer" ref={imageLayerRef} />
        <div className="text-layer" ref={textLayerRef}>
          <TextLayer />
        </div>
        <canvas className="stage-canvas stage-ink" ref={inkRef} />
        <canvas className="stage-canvas stage-highlight" ref={highlightRef} />
        <canvas className="stage-canvas stage-live" ref={liveRef} />
      </div>
      <input
        ref={imageInputRef}
        className="visually-hidden"
        type="file"
        accept={IMAGE_MIME_TYPES.join(',')}
        multiple
        tabIndex={-1}
        aria-hidden="true"
        data-image-input
        onChange={(e) => {
          if (e.target.files) insertPickedImages(e.target.files);
          // Lets the same file be picked again later.
          e.target.value = '';
        }}
      />
      {menu ? <CanvasContextMenu request={menu} onClose={closeMenu} /> : null}
    </>
  );
}
