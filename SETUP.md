# TabLens — Setup & Usage Guide

A privacy-first, full-text search tool for all your open browser tabs.
Zero network calls. Everything runs locally.

---

## File Structure

```
TabLens/
├── manifest.json              ← Extension manifest (MV3)
├── background.js              ← Service worker: indexing & search logic
├── content.js                 ← Injected into every tab: text extraction + overlay
├── overlay.html               ← The search palette UI (loaded in iframe)
├── overlay.css                ← Catppuccin Mocha dark theme styles
├── overlay.js                 ← Search UI logic: input, results, keyboard nav
├── lib/
│   └── flexsearch.bundle.module.min.js   ← ⚠️  YOU MUST DOWNLOAD THIS
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Step 1 — Download FlexSearch

TabLens uses [FlexSearch](https://github.com/nextapps-de/flexsearch) for
fast in-memory full-text indexing. You must download it manually:

```
https://cdn.jsdelivr.net/npm/flexsearch@0.8.0/dist/flexsearch.bundle.module.min.js
```

Save the file to:

```
TabLens/lib/flexsearch.bundle.module.min.js
```

**Using curl:**
```bash
curl -L "https://cdn.jsdelivr.net/npm/flexsearch@0.8.0/dist/flexsearch.bundle.module.min.js" \
     -o TabLens/lib/flexsearch.bundle.module.min.js
```

**Using wget:**
```bash
wget "https://cdn.jsdelivr.net/npm/flexsearch@0.8.0/dist/flexsearch.bundle.module.min.js" \
     -O TabLens/lib/flexsearch.bundle.module.min.js
```

---

## Step 2 — Icons (already included)

The `icons/` folder contains auto-generated icon16.png, icon48.png, and
icon128.png. If you want custom icons, replace them with your own PNGs at
those exact sizes.

---

## Step 3 — Load the Extension in Chrome

1. Open **chrome://extensions** in your browser.
2. Enable **Developer Mode** (toggle in the top-right corner).
3. Click **"Load unpacked"**.
4. Select the **TabLens/** folder (the one containing `manifest.json`).
5. The TabLens extension will appear in your toolbar.

### Grant Optional Permissions

The first time you use TabLens on a new page, Chrome may ask you to grant
access to "all URLs". Click **Allow** to enable full indexing across all tabs.

---

## Step 4 — Usage

### Open the Search Overlay

| Method         | Action                                     |
|----------------|--------------------------------------------|
| Keyboard       | **Ctrl+Shift+K** (Windows/Linux)           |
| Keyboard       | **Cmd+Shift+K** (macOS)                    |
| Mouse          | **Triple-click** anywhere on a page        |

### Search

- Start typing immediately — results appear as you type (debounced 150ms).
- Results show: **favicon · tab title · URL · contextual snippet**.
- Ranked by relevance via FlexSearch.

### Navigate Results

| Key        | Action                    |
|------------|---------------------------|
| `↑` / `↓` | Move selection up/down    |
| `Enter`    | Switch to highlighted tab |
| `Esc`      | Close the overlay         |
| Click      | Switch to that tab        |

### Close the Overlay

- Press **Escape**.
- Click the dark backdrop outside the panel.
- Navigate to a tab (auto-closes).

---

## How It Works (Architecture)

```
Browser Tabs
     │
     │  content.js extracts document.body.innerText
     ▼
background.js  ←──  PAGE_TEXT message
     │
     ├─► FlexSearch.Index  (in-memory full-text index)
     └─► tabMeta Map       (title, url, favicon, text)

Ctrl+Shift+K
     │
     ▼
background.js ──► TOGGLE_OVERLAY ──► content.js
                                          │
                                    iframe: overlay.html
                                          │
                                    overlay.js
                                          │
                                    SEARCH message ──► background.js
                                          │                  │
                                          └──────────────────┘
                                          ranked results rendered
```

All data stays in your browser. No analytics, no external requests.

---

## Troubleshooting

### "No results" even after typing

- **Visit a few pages first.** TabLens indexes pages as you load them.
  Open some tabs and let them fully load before searching.
- The service worker may have restarted (Chrome kills idle SWs). Visiting
  any page will re-trigger injection and re-indexing.

### Extension doesn't open on some pages

- **chrome:// pages are restricted** by Chrome's security model.
  TabLens cannot inject into `chrome://settings`, `chrome://extensions`, etc.
- PDF viewer pages and some browser-internal pages are also restricted.

### Memory Saver tabs

Chrome's Memory Saver (formerly Tab Discarding) freezes tabs to save RAM.
TabLens automatically saves a summary (10,000 chars) of discarded tabs
to `chrome.storage.local` so they remain searchable.

### Service worker restarts

Manifest V3 service workers are killed after ~30s of inactivity and
restarted on demand. When the SW restarts:
1. It reads persisted text from `chrome.storage.local`.
2. It re-injects `content.js` into all open tabs to rebuild the index.

This means there may be a brief moment after SW restart where some tabs
aren't indexed yet. Waiting a second and searching again resolves this.

### Keyboard shortcut conflict

If Ctrl+Shift+K / Cmd+Shift+K is already used by another extension or app:
1. Go to **chrome://extensions/shortcuts**.
2. Find **TabLens → Toggle search**.
3. Click the field and press your preferred shortcut.

---

## Security & Privacy

- **Zero network calls.** All indexing and searching is 100% local.
- **No data leaves your browser.** Not even metadata.
- **Isolated iframe.** The overlay UI cannot access the host page's DOM.
- **Storage.local only.** Discarded tab text is saved locally in Chrome's
  sandboxed extension storage, not synced to your Google account.

---

## Next Steps / Enhancements

### UI & UX
- **Options/popup page** — Configure max results, snippet length, keyboard shortcut.
- **Tab grouping indicators** — Show Chrome tab group colour/name in results.
- **Regex search** — Toggle for power users who want pattern matching.
- **Search history** — Remember recent queries with keyboard recall (↑ in empty input).

### Indexing
- **PDF search via pdf.js** — Extract text from PDF tabs and index them.
- **Bookmark integration** — Index bookmarks alongside open tabs.
- **History search** — Extend index to recently closed tabs from `chrome.history`.
- **Export results** — Copy search results to clipboard as Markdown or JSON.

### Distribution
- **Chrome Web Store checklist:**
  - [ ] Create a 1280×800 or 640×400 promotional screenshot
  - [ ] Write a detailed store description
  - [ ] Add a privacy policy URL (can be a GitHub page)
  - [ ] Set category: "Productivity"
  - [ ] Pay the one-time $5 developer registration fee
  - [ ] Submit for review (typically 1-3 business days)

### Performance
- **Streaming indexing** — Index text incrementally as the page loads.
- **Worker thread** — Move FlexSearch to a separate worker for large indexes.
- **LRU cache** — Evict least-recently-used tab indexes to cap memory usage.

---

*TabLens v1.0.0 — Built with FlexSearch + Manifest V3*