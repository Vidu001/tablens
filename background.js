/**
 * background.js — TabLens Service Worker
 *
 * This is the central brain of TabLens. It runs as a Manifest V3 service worker
 * and is responsible for:
 *   1. Maintaining a FlexSearch full-text index of every open tab's visible text.
 *   2. Receiving PAGE_TEXT messages from content scripts and indexing them.
 *   3. Responding to SEARCH queries from the overlay UI.
 *   4. Handling SWITCH_TAB commands to focus a specific tab.
 *   5. Persisting text for "Memory Saver" discarded tabs to chrome.storage.local.
 *   6. Bootstrapping: injecting content.js into all existing tabs on SW start.
 *
 * ─────────────────────────────────────────────────────────────────
 *  DATA FLOW DIAGRAM
 * ─────────────────────────────────────────────────────────────────
 *
 *  Browser Tabs (n tabs)
 *       │
 *       │  content.js extracts innerText → sends PAGE_TEXT message
 *       ▼
 *  chrome.runtime.onMessage ──► handlePageText()
 *       │                            │
 *       │                            ├─► sanitiseText()
 *       │                            ├─► flexIndex.update(tabId, text)
 *       │                            └─► tabMeta.set(tabId, { title, url, ... })
 *       │
 *  overlay.js (iframe)
 *       │
 *       │  sends SEARCH message with query string
 *       ▼
 *  chrome.runtime.onMessage ──► handleSearch()
 *       │                            │
 *       │                            ├─► flexIndex.search(query, MAX_RESULTS)
 *       │                            ├─► map IDs → tabMeta entries
 *       │                            └─► generateSnippet(text, query)
 *       │                                      │
 *       │◄─────────────────────────────────────┘
 *       │  returns array of { tabId, title, url, faviconUrl, snippet }
 *       ▼
 *  overlay.js renders results
 *
 *  chrome.commands.onCommand("toggle-search")
 *       │
 *       ▼
 *  sendMessageToActiveTab({ type: "TOGGLE_OVERLAY" })
 *       │  (injects content.js first if not yet present)
 *       ▼
 *  content.js creates/removes iframe overlay
 *
 * ─────────────────────────────────────────────────────────────────
 */

// ── 1. Import FlexSearch as an ES module ───────────────────────────────────────
import FlexSearch from "./lib/flexsearch.bundle.module.min.js";

// ── 2. Configuration constants ─────────────────────────────────────────────────
const MAX_TEXT_LENGTH  = 50_000; // chars stored per tab in the index
const SUMMARY_LENGTH   = 10_000; // chars saved for discarded tabs in storage
const SNIPPET_CONTEXT  = 80;     // chars on each side of a match for snippet
const MAX_RESULTS      = 20;     // maximum search results returned

// ── 3. FlexSearch index ────────────────────────────────────────────────────────
// tokenize: "forward" — indexes prefix tokens, good for live search-as-you-type
// cache: 100 — caches the last 100 unique query results for speed
// resolution: 9 — highest relevance scoring resolution
const flexIndex = new FlexSearch.Index({
  tokenize:   "forward",
  cache:      100,
  resolution: 9
});

// ── 4. In-memory tab metadata map ─────────────────────────────────────────────
// Maps tabId (number) → { title, url, faviconUrl, text }
// This is the source of truth for snippet generation and result display.
const tabMeta = new Map();

// ═══════════════════════════════════════════════════════════════════════════════
// TAB LIFECYCLE EVENTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fires when a tab's status or properties change.
 * We care about two cases:
 *   a) status === "complete"  → page fully loaded, inject content script
 *   b) discarded === true     → Chrome "Memory Saver" froze the tab,
 *                               so we persist its last-known text to storage
 *                               before the renderer process dies.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.discarded === true) {
    persistTabText(tabId);
  }
});

/**
 * Fires when a tab is closed.
 * Remove its data from the index, the metadata map, and storage.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  removeFromIndex(tabId);
});

/**
 * Fires when a tab's ID changes (e.g., after prerendering or navigation swap).
 * Remove the old ID and inject into the new tab.
 */
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  removeFromIndex(removedTabId);
});

// ═══════════════════════════════════════════════════════════════════════════════
// KEYBOARD COMMAND HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Listens for the "toggle-search" command (Ctrl+Shift+K / Cmd+Shift+K).
 * Sends a TOGGLE_OVERLAY message to the active tab's content script.
 * If content.js hasn't been injected yet (e.g. the SW just restarted),
 * we programmatically inject it first, then send the message after a short delay.
 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-search") return;

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) return;

  // Guard: can't inject into chrome:// or other restricted URLs
  if (isRestrictedUrl(activeTab.url)) return;

  try {
    await chrome.tabs.sendMessage(activeTab.id, { type: "TOGGLE_OVERLAY" });
  } catch {
    // Content script not yet present — inject it, then send after delay
    await injectContentScript(activeTab.id);
    setTimeout(async () => {
      try {
        await chrome.tabs.sendMessage(activeTab.id, { type: "TOGGLE_OVERLAY" });
      } catch (err) {
        console.warn("[TabLens BG] Could not toggle overlay after injection:", err);
      }
    }, 150);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE ROUTER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Central message dispatcher.
 * All messages from content.js and overlay.js arrive here.
 *
 * Message types:
 *   PAGE_TEXT    — content script sends extracted page text
 *   SEARCH       — overlay asks for search results
 *   SWITCH_TAB   — overlay wants to focus a specific tab
 *   GET_OVERLAY_URL — content script needs the extension URL for the iframe
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    case "PAGE_TEXT":
      handlePageText(message, sender);
      // No async response needed; fire-and-forget
      return false;

    case "SEARCH":
      // handleSearch is async; must return true to keep channel open
      handleSearch(message.query).then(sendResponse);
      return true;

    case "SWITCH_TAB":
      handleSwitchTab(message.tabId).then(sendResponse);
      return true;

    case "GET_OVERLAY_URL":
      sendResponse({ url: chrome.runtime.getURL("overlay.html") });
      return false;

    default:
      return false;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER: PAGE_TEXT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Receives page text extracted by content.js, sanitises it, and stores it
 * in both the FlexSearch index and our tabMeta map.
 *
 * @param {object} message  - { type, text }
 * @param {object} sender   - chrome MessageSender (contains sender.tab)
 */
function handlePageText(message, sender) {
  const tab = sender.tab;
  if (!tab?.id) return;

  const tabId     = tab.id;
  const cleanText = sanitiseText(message.text);
  const title     = tab.title     || "";
  const url       = tab.url       || "";
  const faviconUrl = tab.favIconUrl || "";

  // Add or update the document in FlexSearch.
  // FlexSearch.Index.update() is safe to call even on first insert.
  flexIndex.update(tabId, cleanText);

  // Store metadata for snippet generation and result rendering
  tabMeta.set(tabId, { title, url, faviconUrl, text: cleanText });
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER: SEARCH
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Runs a full-text search across all indexed tabs and returns ranked results.
 *
 * @param {string} query - The user's search string
 * @returns {Promise<Array>} - Array of result objects
 */
async function handleSearch(query) {
  if (!query || query.trim().length === 0) return [];

  // FlexSearch returns an array of tabId numbers, ranked by relevance
  const matchedIds = flexIndex.search(query, { limit: MAX_RESULTS });

  const results = [];
  for (const tabId of matchedIds) {
    const meta = tabMeta.get(tabId);
    if (!meta) continue;

    const snippet = generateSnippet(meta.text, query);
    results.push({
      tabId,
      title:      meta.title,
      url:        meta.url,
      faviconUrl: meta.faviconUrl,
      snippet
    });
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER: SWITCH_TAB
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Focuses the specified tab and its parent window.
 *
 * @param {number} tabId - The tab to switch to
 * @returns {Promise<void>}
 */
async function handleSwitchTab(tabId) {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (err) {
    console.warn("[TabLens BG] Could not switch to tab:", tabId, err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SNIPPET GENERATOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generates a short contextual snippet from the tab's full text, surrounding
 * the best match location for the given query.
 *
 * Strategy:
 *   1. Try exact phrase match (case-insensitive indexOf)
 *   2. Fall back to the first individual token that matches
 *   3. Fall back to the first 160 characters of the text
 *
 * @param {string} text   - Full sanitised tab text
 * @param {string} query  - The search query
 * @returns {string}      - A short snippet string (~160 chars)
 */
function generateSnippet(text, query) {
  if (!text) return "";

  const lowerText  = text.toLowerCase();
  const lowerQuery = query.toLowerCase().trim();

  // ── Strategy 1: Exact phrase match ─────────────────────────────────────────
  const phraseIdx = lowerText.indexOf(lowerQuery);
  if (phraseIdx !== -1) {
    return extractAround(text, phraseIdx, SNIPPET_CONTEXT);
  }

  // ── Strategy 2: First matching token ───────────────────────────────────────
  const tokens = lowerQuery.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const tokenIdx = lowerText.indexOf(token);
    if (tokenIdx !== -1) {
      return extractAround(text, tokenIdx, SNIPPET_CONTEXT);
    }
  }

  // ── Strategy 3: Fallback to start of document ──────────────────────────────
  return text.slice(0, 160).trim() + (text.length > 160 ? "…" : "");
}

/**
 * Extracts a substring centred around `position`, with `context` chars on
 * each side, adding ellipsis markers at truncated ends.
 *
 * @param {string} text     - Source text
 * @param {number} position - Character index of the match
 * @param {number} context  - Characters to include before and after the match
 * @returns {string}
 */
function extractAround(text, position, context) {
  const start = Math.max(0, position - context);
  const end   = Math.min(text.length, position + context + 40);
  let snippet = text.slice(start, end).trim();
  if (start > 0)              snippet = "…" + snippet;
  if (end < text.length)     snippet = snippet + "…";
  return snippet;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEXT SANITISATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalises extracted page text for consistent indexing:
 *   - Collapses multiple whitespace characters to a single space
 *   - Trims leading/trailing whitespace
 *   - Truncates to MAX_TEXT_LENGTH to cap memory usage
 *
 * @param {string} raw - Raw text from document.body.innerText
 * @returns {string}   - Cleaned text
 */
function sanitiseText(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}



// ═══════════════════════════════════════════════════════════════════════════════
// INDEX CLEANUP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Removes all data associated with a closed or replaced tab.
 *
 * @param {number} tabId
 */
async function removeFromIndex(tabId) {
  // Remove from FlexSearch (no-op if not present)
  flexIndex.remove(tabId);

  // Remove from in-memory metadata map
  tabMeta.delete(tabId);

  // Remove from persistent storage (discarded tab backups)
  try {
    await chrome.storage.local.remove(`tab_${tabId}`);
  } catch {
    // Storage removal errors are non-critical
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCARDED TAB PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Saves a tab's text to chrome.storage.local before it gets discarded by
 * Chrome's "Memory Saver" feature. We cap it to SUMMARY_LENGTH to be kind
 * on storage quota.
 *
 * @param {number} tabId
 */
async function persistTabText(tabId) {
  const meta = tabMeta.get(tabId);
  if (!meta?.text) return;

  try {
    await chrome.storage.local.set({
      [`tab_${tabId}`]: {
        text:       meta.text.slice(0, SUMMARY_LENGTH),
        title:      meta.title,
        url:        meta.url,
        faviconUrl: meta.faviconUrl
      }
    });
  } catch (err) {
    console.warn("[TabLens BG] Could not persist tab text:", tabId, err);
  }
}

/**
 * On service-worker start, restore discarded tab data from storage into
 * the FlexSearch index so those tabs remain searchable even without a live
 * renderer. Also purges entries for tabs that no longer exist.
 */
async function restoreDiscardedTabs() {
  try {
    // Get all currently open tab IDs
    const allTabs  = await chrome.tabs.query({});
    const liveIds  = new Set(allTabs.map(t => t.id));

    // Retrieve everything in storage
    const allStorage = await chrome.storage.local.get(null);

    const staleKeys = [];

    for (const [key, data] of Object.entries(allStorage)) {
      if (!key.startsWith("tab_")) continue;

      const tabId = parseInt(key.slice(4), 10);

      if (!liveIds.has(tabId)) {
        // Tab no longer exists — schedule cleanup
        staleKeys.push(key);
        continue;
      }

      // Tab still exists but may be discarded — restore its text
      if (data?.text) {
        flexIndex.update(tabId, data.text);
        tabMeta.set(tabId, {
          title:      data.title      || "",
          url:        data.url        || "",
          faviconUrl: data.faviconUrl || "",
          text:       data.text
        });
      }
    }

    // Purge stale storage entries
    if (staleKeys.length > 0) {
      await chrome.storage.local.remove(staleKeys);
    }
  } catch (err) {
    console.warn("[TabLens BG] restoreDiscardedTabs error:", err);
  }
}


// ── Utility: restricted URL check ─────────────────────────────────────────────

/**
 * Returns true for URLs that Chrome will not allow scripting into.
 *
 * @param {string|undefined} url
 * @returns {boolean}
 */
function isRestrictedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("about:") ||
    url.startsWith("edge://") ||
    url.startsWith("devtools://") ||
    url === "about:blank" ||
    url === ""
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// CONTENT SCRIPT INJECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Inject content.js into a tab.
 */
async function injectContentScript(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);

    if (!tab?.id) return;
    if (tab.discarded) return;
    if (isRestrictedUrl(tab.url)) return;

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });

  } catch (err) {
    // Restricted pages are expected to fail
  }
}

/**
 * Inject content.js into ALL currently open tabs.
 * This rebuilds the search index after service worker restarts.
 */
async function indexAllOpenTabs() {
  const tabs = await chrome.tabs.query({});

  for (const tab of tabs) {
    if (!tab.id) continue;
    if (tab.discarded) continue;
    if (isRestrictedUrl(tab.url)) continue;

    injectContentScript(tab.id);
  }
}
// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY POINT — run on every SW start
// ═══════════════════════════════════════════════════════════════════════════════

(async () => {

  // Restore discarded tab data
  await restoreDiscardedTabs();

  // Re-index ALL open tabs
  await indexAllOpenTabs();

})();