# Inkwell

A local-first, OneNote-style notebook: an infinite ink canvas combined with rich-text
blocks, organized as Notebooks → Sections → Pages. Everything is stored in your
browser's IndexedDB. There is no server and no cloud dependency.

## Run it

Requires Node 20.19+ or 22.12+ (a Vite 8 requirement).

```bash
npm install
npm run dev        # http://localhost:5173
```

Other commands:

```bash
npm run build      # type-check, then production build into dist/
npm run preview    # serve the production build locally
npm test           # unit tests (Vitest)
npm run typecheck  # TypeScript only
```

## Controls

| Action | Input |
| --- | --- |
| Snap a stroke to a shape | With the pen or highlighter, keep the pointer still for about half a second at the end of the stroke, without lifting |
| Pan | Two-finger trackpad scroll, middle-click drag, Space + drag, or the Hand tool |
| Zoom at cursor | Ctrl/Cmd + scroll, trackpad pinch, two-finger touch pinch (10% to 800%) |
| Reset zoom | Ctrl/Cmd + 0 |
| Undo / redo | Ctrl/Cmd + Z, Shift + Ctrl/Cmd + Z (or Ctrl/Cmd + Y) |
| Context menu | Right-click the canvas, a selection, an image or a text box |
| Copy / cut / paste | Ctrl/Cmd + C, X, V (or the context menu) |
| Duplicate selection | Ctrl/Cmd + D |
| Insert image | Toolbar button, context menu, drag an image file onto the canvas, or paste one |
| Delete selection | Delete or Backspace |
| Clear selection | Escape |

Tool shortcuts, active whenever you are not typing:

| Key | Tool |
| --- | --- |
| P | Pen |
| H | Highlighter |
| E | Eraser (removes whole strokes) |
| L | Lasso select strokes and images (drag inside the selection to move it) |
| T | Text (click the canvas to place a text box) |
| V | Hand / pan |

### Hold to snap

Draw a rough line, rectangle, ellipse or triangle and hold still before lifting: the
stroke is replaced by the clean shape, with a brief highlight to confirm it.

- Nearly square rectangles become squares and nearly round ellipses become circles.
- Lines within a few degrees of horizontal or vertical are made exact. While you keep
  holding, the far end of a snapped line follows the pointer so you can aim it.
- Rectangles are axis-aligned; a rectangle drawn at an angle is left as you drew it.
- Anything that does not clearly look like one of those shapes (handwriting, scribbles,
  open arcs) is left alone, and you can simply keep drawing.
- A snapped shape is an ordinary stroke: undo, the eraser, lasso move and delete, and
  backups treat it like any other ink.

Pen strokes have round ends and round corners, with a gentle variation in width from
pen pressure or, without a pressure-sensitive pen, from drawing speed.

### Context menu, copy and paste

Right-clicking the canvas opens a menu with Cut, Copy, Paste, Duplicate, Delete and
Insert image; commands that do not apply to what is under the pointer are disabled.
On an image it also offers Lock / Unlock, Bring to front and Send to back. While you
are typing in a text box, right-click and the clipboard shortcuts keep their normal
text behaviour.

- Copy, cut, paste and duplicate work on lasso selections (strokes and images
  together) and, through the menu, on a single image or text box. Every one of them,
  and Delete, can be undone.
- Paste puts the content under the pointer (or in the middle of the view when the
  pointer is elsewhere), selects it, and shifts repeated pastes a little so copies do
  not hide each other. You can paste on another page or in another section.
- The most recent copy wins, wherever it was made: after copying in Inkwell, Paste
  inserts that; after copying a screenshot or text in another app, Ctrl/Cmd + V inserts
  the image, or a text box with the text. Copied ink and images stay inside Inkwell
  (other apps only receive the text of copied text boxes).
- Paste from the menu has to ask the browser for the system clipboard, so the browser
  may ask for permission the first time. If that is declined, the menu pastes what was
  last copied in Inkwell.

### Images

Images sit on the page below the ink, so you can write and highlight on top of them.
PNG, JPEG, WebP, GIF, BMP and AVIF files are accepted.

- A new image is placed at its own size, or smaller if it would not fit in the view; it
  is never enlarged. With the Lasso tool, click an image to select it, drag it to move
  it, drag a corner handle to resize it (the proportions are kept), and press Delete to
  remove it.
- **Lock** (right-click the image) protects an image: a locked image cannot be selected,
  moved, resized or deleted and shows a small lock badge. Right-click it and choose
  Unlock to change it again.
- The eraser only erases ink. It never affects images, locked or not.
- Images whose longest side is over 4096 pixels are scaled down to 4096 pixels when they
  are inserted, and files over 6 MB are re-compressed, so one photo cannot bloat the
  database.

Text boxes support bold, italic, headings, bullet lists, checkbox lists, and code
blocks through the formatting bar that appears on focus, plus the usual keyboard
shortcuts. Drag a box by its handle and resize it from its edge. Empty boxes are
removed when they lose focus.

## Page backgrounds

Each page has its own background, chosen in the top bar: Blank, Ruled, College ruled,
Dot grid or Grid (square graph paper). The patterns are infinite, scale with zoom,
stay crisp at any zoom level, and thin out and fade when zoomed far out.

## Data and backups

- All data lives in IndexedDB for the origin you run the app on. Clearing site data
  for `localhost:5173` deletes it, so export backups regularly.
- Images are stored as binary data in their own table, separate from the small records
  that say where each image is, so moving an image never rewrites its pixels. Deleting
  a page, section or notebook deletes its images too.
- **Export Backup (.json)** downloads a versioned snapshot of the whole database,
  including every image (embedded as base64, so backups with many photos are large).
  The current backup format is version 2; backups made before images existed
  (version 1) can still be imported.
- **Import Backup** replaces everything with the contents of the file, after a
  confirmation. The file is validated first; an invalid file is rejected with a
  message and nothing is changed.

## Dark mode

The theme follows the system preference until you toggle it, and the choice is
remembered. Ink colors are remapped at render time, so black ink shows as white in
dark mode and the stored stroke data is never modified.

## Project structure

```
index.html
vite.config.ts
tsconfig.json
src/
  main.tsx, App.tsx, types.ts
  canvas/
    CanvasEngine.ts          Imperative engine: camera, input routing, rAF loop, undo history
    contextMenuModel.ts      Which context-menu commands apply to what, menu placement
    imageImport.ts           Decodes inserted images and scales down oversized ones
    math/                    Pure, DOM-free math (unit tested)
      camera.ts              World/screen transforms, zoom about a point
      smoothing.ts           Centripetal Catmull-Rom resampling
      strokeInput.ts         Input stabilisation, pressure/velocity to width
      strokeGeometry.ts      Stroke outlines (round caps and joins, crisp shapes), bounds
      shapeRecognition.ts    Hold-to-snap: line / rectangle / ellipse / triangle fitting
      spatialIndex.ts        Uniform grid hash for viewport culling
      geometry.ts, hitTest.ts  Point-in-polygon, segment distance, lasso/eraser hits
      backgroundPattern.ts   Ruled / college ruled / dot grid / square grid layout
      imageGeometry.ts       Image sizing, corner resizing, image hit tests
      clipboard.ts           Copy/paste rules: internal vs system clipboard, placing copies
      colors.ts, history.ts  Theme color mapping, undo/redo stack
    render/                  Stroke model, cached Path2D, ink layers, image layer, background
    tools/                   DrawTool (pen/highlighter, hold to snap), EraserTool (ink only),
                             LassoTool (strokes and images, move, resize)
  db/
    database.ts              Dexie schema (version 2 adds the image tables)
    repositories.ts          Queries per table
    writeQueue.ts            Batched, debounced writes with flush on tab hide
    persistence.ts, seed.ts, factories.ts
    backup.ts                Export, validation, import (format version 2, reads version 1)
    base64.ts                Binary data in backup files
    search.ts                Title and text search
  store/                     Zustand app store, page tree helpers, canvasActions.ts
                             (clipboard, image and object commands)
  components/                Sidebar, toolbar, top bar, canvas view, context menu, text boxes
  hooks/                     Tool keyboard shortcuts, canvas clipboard shortcuts
  styles/                    Design tokens (light/dark) and component CSS
```

## How rendering works

Five stacked layers share one camera: a background-pattern canvas, a DOM image
layer, the DOM text layer, the pen ink canvas, and a highlighter canvas that blends over the text
(multiply in light mode, screen in dark mode). The stroke being drawn is painted on
a separate live canvas so committed strokes are not re-rasterised on every pointer
move. Frames are scheduled with `requestAnimationFrame` only when something changed,
and only strokes whose bounds intersect the viewport, found through the spatial
index, are drawn. Images are plain
`<img>` elements moved by one CSS transform; those outside the view are hidden.
