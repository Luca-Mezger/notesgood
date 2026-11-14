# Notesgood

A handwriting note-taking app in the spirit of GoodNotes: stylus ink, PDF annotation with
a writable margin beside every page, and LaTeX. One web codebase that runs in the browser,
on NixOS and on Android. Notes are stored on the device (IndexedDB) and can be synced between
your devices through a tiny server you host yourself; there are no accounts.

## Run it

A prebuilt copy is in `dist/`, so you only need Node to serve it:

```sh
nix develop            # NixOS: shell with Node (or use any Node >= 20)
node scripts/serve.mjs # http://localhost:5173
```

To work on the code:

```sh
npm install
npm run dev        # rebuilds on change, serves http://localhost:5173
npm run build      # production build into dist/
npm run typecheck
```

`dist/` is plain static files, so any web server or static host works.

### Android

Host `dist/` over HTTPS (any static host), open it in Chrome on the tablet and choose
**Install app**. It then runs full screen and works offline. For a first try on the same
network, `http://<your-pc-ip>:5173` works in the browser, but installing and offline use need HTTPS.
A Play-Store-style APK can be produced later by wrapping `dist/` with Capacitor; no code changes needed.

### NixOS

`nix run` serves `dist/` from the project directory. For a desktop window without browser
chrome: `chromium --app=http://localhost:5173`. In Firefox on X11, pen pressure needs
`MOZ_USE_XINPUT2=1`; on Wayland it works out of the box.

## Sync between devices

Notes sync through a small endpoint you host: `server/sync.php` for PHP hosting (Hostinger shared
hosting and similar) or `server/sync.mjs` for a VPS with Node. Both keep the data as plain files.

1. Put `sync.php` on your host (the deploy workflow below does this) with a `sync-key.txt` next to it
   containing one secret line of your choosing. The data lands in `sync-data/` beside it.
2. In the app, on every device: Library → **Sync** → enter the URL of `sync.php` and the secret.
   On the device that already has notes, press **Upload all notes from this device** once.

Changes are pushed while you write (every 45 s and when you leave a notebook) and pulled whenever the
library is shown, so a notebook edited on the tablet appears on the laptop the next time you open
the library there. If the same notebook is edited on two devices at once, the later save wins per page.
PDFs and pictures are uploaded once and downloaded on demand; a 50 MB lecture PDF is only ever
transferred once per device. Shared PHP hosts often cap uploads at 64–128 MB per file; larger PDFs
will not sync (the notebook still works locally).

## Deploying (GitHub Pages + Hostinger)

`.github/workflows/deploy.yml` builds the app on every push to `main` and deploys it to GitHub Pages.
If the repository has the secrets `FTP_HOST`, `FTP_USER`, `FTP_PASSWORD`, `FTP_DIR` (e.g.
`/public_html/notesgood/`) and `SYNC_KEY`, it also uploads the app and `sync.php` to that folder on your
Hostinger site, so `https://your-domain/notesgood/` is the installable app and
`https://your-domain/notesgood/sync.php` is the sync server. Any device, Android included, can then
install it from the browser's menu and use it offline.

## Installing it as an app

Notesgood is a web app, which is what lets one codebase run on NixOS, Android and everything else.
"Installing" it means letting the browser wrap it as a standalone app with its own icon, full screen, offline:

- **Android:** open the HTTPS address where it is hosted in Chrome → ⋮ → *Add to Home screen* → *Install*.
- **Linux / NixOS desktop:** Chromium → ⋮ → *Cast, save and share* → *Install page as app*. It then
  appears in your launcher. (Firefox cannot install web apps; `chromium --app=<url>` is the equivalent.)
- A Play-Store-style APK can be produced from the hosted URL with Bubblewrap (Trusted Web Activity); see
  the deploy prompt in `docs/`. It is the same app in a thin Android shell, not a separate codebase.

## What it does

- **Library**: notebook covers, folders, favourites, search, sort. Drop a PDF on the window to import.
- **PDF import**: choose how much writing space to add to the right of every page (and its ruling).
  Up to 5x the page width. Change it later from the toolbar; ink keeps its position.
- **Tools**: pressure-sensitive pen with adjustable smoothing, highlighter (mark or underline, freehand or
  straight), eraser (whole stroke or partial), a ruler to draw along (R),
  On PDF pages, underlines and straight highlights snap to the printed text line under the pen, with the
  thickness taken from the font size (settings → Snap to printed text). shapes (line, arrow, rectangle,
  ellipse), text boxes, LaTeX blocks, lasso (move, resize, rotate, recolour, duplicate, delete, snap to
  grid, convert to LaTeX or text), undo/redo.
- **LaTeX**: the Σ tool places a rendered formula anywhere, including the PDF margin. Text boxes
  render `$...$` as inline maths.
- **Pages grow downward**: write near the bottom of a PDF page and it gains half a page of space below;
  trim it again from the margin menu.
- **Handwriting → LaTeX / text**: lasso some handwriting and press *To LaTeX* or *To text*. This sends an
  image of the selected strokes to the Claude API with a key you enter under Settings; the key stays in
  the browser. Without a key the rest of the app works as before.
- **Dark mode** (Settings → Appearance): paper, ink, text and PDFs are inverted, pictures keep their colours.
- **Hold to straighten**: rest the pen at the end of a stroke and it becomes a clean line, rectangle,
  ellipse or triangle (settings: on/off and hold time).
- **Pictures**: paste (Ctrl+V), drop, or insert from the toolbar; move and resize with the lasso.
  Lock a picture so it stays put; unlock from the lasso options. Ctrl+C / Ctrl+V also copies lasso selections between pages.
- **Bulk import**: drop several PDFs, a folder, or a ZIP of PDFs (as GoodNotes exports them); folders are kept.
- **Pages**: sidebar with thumbnails; add, reorder and delete pages.
- **Settings**: pressure, hold-to-straighten and its delay, straight highlighter, finger drawing, text
  snapping, toolbar at the top or on the left side.
- **Export**: any notebook as a PDF (original PDF pages kept as they are, ink as vector paths, text and
  formulas as a 3x image layer).
- **Backup**: one notebook or all of them as a `.notesgood` file; importing it restores them as new copies.

### Input

| Device | Behaviour |
| --- | --- |
| Stylus | Always writes. The eraser end / barrel button erases. After the first stylus contact, fingers only scroll (palm rejection). |
| Finger | One finger scrolls, two fingers pinch-zoom. Toggle "draw with finger" in the toolbar for devices without a stylus. |
| Mouse | Draws. Middle button pans, Ctrl+wheel zooms. |

Shortcuts: `P` pen, `H` highlighter, `E` eraser, `S` shapes, `T` text, `M` LaTeX, `L` lasso, `V` move,
`Ctrl+Z` / `Ctrl+Shift+Z`, `Ctrl+0` fit width, `Delete` removes the selection.

## How it is built

No framework: TypeScript, bundled by esbuild. KaTeX renders maths, pdf.js renders PDFs.

| File | Role |
| --- | --- |
| `src/editor.ts` | Page layout, zoom/pan, pointer input, tools, undo, autosave |
| `src/render.ts` | Stroke/shape drawing, paper rulings, hit-testing geometry |
| `src/library.ts` | Notebook overview, PDF import dialog |
| `src/pdf.ts` | pdf.js wrapper and render queue (loaded on demand) |
| `src/db.ts` | IndexedDB storage |
| `src/export.ts` | PDF export (pdf-lib) and backup files |
| `src/sync.ts`, `server/` | Device sync client; PHP and Node sync servers |
| `src/thumb.ts`, `src/latex.ts`, `src/ui.ts` | Thumbnails, KaTeX helpers, small DOM helpers |

Writing latency: the stroke in progress is drawn straight from the pointer event (using all
coalesced stylus samples) onto a low-latency overlay canvas, and only the new segment is drawn
each time. Finished strokes are baked into a per-page canvas; only pages near the viewport hold canvases.

## Importing from GoodNotes

GoodNotes' own `.goodnotes` files are a closed format, so they cannot be read directly. In GoodNotes,
select your folders in the Documents view, choose Export with PDF as the format, and import the ZIP it
produces here (⋯ → Import from GoodNotes… shows the same steps). Each notebook becomes a PDF notebook
with your chosen writing margin; your old handwriting is part of the page image, so it can be written over
but not erased stroke by stroke.

## Not there yet

- Sync is last-write-wins per page; there is no merge of simultaneous edits to the same page.
- The sync secret is a single shared key, fine for one person's devices, not for sharing with others.
- Partial (pixel) eraser, handwriting search, reading `.goodnotes` files directly.
- Pages are rendered as one bitmap each (capped at 10 megapixels), so very deep zoom gets soft.
