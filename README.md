# TabLens

A privacy-first Chrome extension that lets you instantly search across the contents of all your open tabs using full-text local indexing.

TabLens creates a fast in-memory search index of visible page text from your tabs, allowing you to jump between tabs like Spotlight or Raycast — but for your browser.

---

## ✨ Features

- 🔍 Full-text search across open tabs
- ⚡ Fast local indexing using FlexSearch
- 🧠 Search page content, not just titles
- ⌨️ Keyboard-first workflow (`Ctrl + Shift + K`)
- 🌑 Beautiful dark-mode overlay UI
- 🔒 100% local & privacy-first
- 🧩 Works across multiple browser windows
- 💾 Supports discarded / Memory Saver tabs
- 🚀 SPA-aware indexing for modern web apps
- 🪟 Seamless tab switching

---

## 📸 Screenshots

> Add screenshots here after capture.

### Search Overlay

![Overlay Screenshot](./screenshots/overlay.png)

### Multi-tab Search Results

![Results Screenshot](./screenshots/results.png)

---

## 🚀 Installation

### Option 1 — Chrome Web Store

Coming soon.

### Option 2 — Load Unpacked (Developer Mode)

1. Clone the repository:

```bash
git clone https://github.com/YOUR_USERNAME/tablens.git
```

2. Download FlexSearch:

```bash
curl -L "https://cdn.jsdelivr.net/npm/flexsearch@0.8.0/dist/flexsearch.bundle.module.min.js" ^
-o TabLens/lib/flexsearch.bundle.module.min.js
```

3. Open Chrome and go to:

```text
chrome://extensions
```

4. Enable **Developer Mode**

5. Click **Load unpacked**

6. Select the `TabLens/` folder

---

## ⌨️ Usage

Open the search overlay:

### Windows / Linux

```text
Ctrl + Shift + K
```

### macOS

```text
Cmd + Shift + K
```

Search for:
- text inside articles
- documentation
- StackOverflow answers
- YouTube titles/descriptions
- notes
- anything visible on a webpage

Press `Enter` to jump to a tab.

---

# 🏗️ Architecture

TabLens is built using Chrome Extension Manifest V3 architecture.

## Core Components

### 1. `content.js`

Injected into browser tabs.

Responsibilities:
- extracts visible page text
- sends text to background service worker
- manages overlay lifecycle

---

### 2. `background.js`

The central event-driven service worker.

Responsibilities:
- maintains FlexSearch index
- handles all extension messaging
- manages search queries
- persists discarded tab state
- coordinates tab switching

---

### 3. `overlay.html + overlay.js`

Isolated iframe-based UI layer.

Responsibilities:
- search input
- keyboard navigation
- rendering results
- communicating with background worker

---

## 🔄 Data Flow

```text
Tab Page
   ↓
content.js extracts innerText
   ↓
chrome.runtime.sendMessage(PAGE_TEXT)
   ↓
background.js updates FlexSearch index
   ↓
User searches query
   ↓
overlay.js sends SEARCH message
   ↓
background.js returns ranked matches
   ↓
overlay renders results
```

---

# ⚡ How Indexing Works

TabLens uses:

## FlexSearch

A high-performance in-memory full-text search engine.

Each tab is indexed using:

```javascript
flexIndex.update(tabId, pageText)
```

Searches are performed locally:

```javascript
flexIndex.search(query)
```

No cloud APIs.
No external database.
No remote processing.

---

# 🧠 Technical Concepts Used

This project explores:

- Event-driven architecture
- Chrome Extension MV3
- Service workers
- IPC messaging
- Full-text indexing
- UI isolation via iframes
- SPA synchronization
- Persistence & restoration
- Browser lifecycle management
- Async systems

---

# 🔒 Privacy-First Design

TabLens is fully local-first.

## Guarantees

- ❌ No analytics
- ❌ No tracking
- ❌ No external servers
- ❌ No data collection
- ❌ No cloud sync
- ✅ All indexing happens locally
- ✅ All searches happen locally

Your browsing data never leaves your machine.

---

# 🧩 Why I Built This

Modern browsers make it easy to open dozens of tabs — but hard to rediscover information buried inside them.

I wanted:
- a Spotlight-like experience for browser tabs
- instant full-text retrieval
- keyboard-first navigation
- privacy-first architecture

TabLens was built to explore:
- browser systems
- search indexing
- MV3 architecture
- async event-driven systems

---

# 🛣️ Future Roadmap

Planned features:

- [ ] Fuzzy search ranking improvements
- [ ] Semantic / embedding search
- [ ] Search history
- [ ] Bookmark indexing
- [ ] Closed tab recovery
- [ ] Cross-device sync
- [ ] Firefox support
- [ ] Keyboard customization
- [ ] Result previews
- [ ] AI-assisted tab summaries

---

# 🛠️ Tech Stack

- JavaScript
- Chrome Extensions API
- Manifest V3
- FlexSearch
- HTML/CSS
- Event-driven architecture

---

# 📄 License

MIT License

---

# 🤝 Contributions

PRs, ideas, and feedback are welcome.

---

# ⭐ If You Like This Project

Consider starring the repository.
