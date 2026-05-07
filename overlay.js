/**
 * overlay.js — TabLens Command Palette UI
 *
 * Runs inside the overlay.html iframe that content.js injects into every page.
 * Responsible for:
 *   1. Listening for keyboard input and triggering debounced searches.
 *   2. Sending SEARCH messages to the background service worker.
 *   3. Rendering ranked results with favicon, title, URL, and snippet.
 *   4. Keyboard navigation (↑↓ arrows, Enter, Escape).
 *   5. Switching to the selected tab via SWITCH_TAB message.
 *   6. Telling content.js to close the overlay via postMessage.
 *
 * ─────────────────────────────────────────────────────────────────
 *  DATA FLOW DIAGRAM
 * ─────────────────────────────────────────────────────────────────
 *
 *  User types in #search-input
 *       │
 *       │  debounce 150ms
 *       ▼
 *  doSearch(query)
 *       │
 *       │  chrome.runtime.sendMessage({ type: "SEARCH", query })
 *       ▼
 *  background.js ──► FlexSearch ──► returns ranked result array
 *       │
 *       ▼
 *  renderResults(results)
 *       │
 *       ▼
 *  #results-list populated with <li> items
 *       │
 *  User presses Enter (or clicks a result)
 *       │
 *       │  chrome.runtime.sendMessage({ type: "SWITCH_TAB", tabId })
 *       ▼
 *  background.js calls chrome.tabs.update + chrome.windows.update
 *       │
 *  overlay.js sends postMessage({ type: "CLOSE_OVERLAY" }) to parent
 *       ▼
 *  content.js removes the iframe container from the DOM
 *
 * ─────────────────────────────────────────────────────────────────
 */

(function () {
  "use strict";

  // ── DOM References ───────────────────────────────────────────────────────────
  const searchInput  = document.getElementById("search-input");
  const resultsList  = document.getElementById("results-list");
  const resultsCount = document.getElementById("results-count");

  // ── State ────────────────────────────────────────────────────────────────────
  let results     = [];   // Current result objects from background.js
  let activeIndex = -1;   // Which result is keyboard-highlighted (-1 = none)
  let debounceTimer = null; // setTimeout handle for input debounce

  // ── Initialise ───────────────────────────────────────────────────────────────
  init();

  function init() {
    // Wire up the search input
    searchInput.addEventListener("input", onInput);
    searchInput.addEventListener("keydown", onKeyDown);

    // Listen for FOCUS_INPUT from content.js (sent after iframe loads)
    window.addEventListener("message", onParentMessage);

    // Auto-focus on load (belt + suspenders alongside the postMessage approach)
    searchInput.focus();
  }

  // ── Messaging from parent (content.js) ──────────────────────────────────────

  /**
   * Handles messages sent via postMessage from the parent content script.
   * Currently only handles FOCUS_INPUT.
   *
   * @param {MessageEvent} event
   */
  function onParentMessage(event) {
    if (event.data?.type === "FOCUS_INPUT") {
      searchInput.focus();
      searchInput.select();
    }
  }

  // ── Input handler ────────────────────────────────────────────────────────────

  /**
   * Fires on every keystroke in the search input.
   * Uses debouncing to avoid sending a message on every single character.
   */
  function onInput() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doSearch, 150);
  }

  // ── Search ───────────────────────────────────────────────────────────────────

  /**
   * Reads the current input value and sends a SEARCH message to the
   * background service worker. Renders the results when they arrive.
   *
   * If the query is empty, clears the results list.
   */
  async function doSearch() {
    const query = searchInput.value.trim();

    if (!query) {
      renderResults([]);
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: "SEARCH",
        query
      });
      // response is an array of result objects (may be empty)
      renderResults(Array.isArray(response) ? response : []);
    } catch (err) {
      // Extension may have been reloaded; show a graceful message
      console.warn("[TabLens Overlay] SEARCH message failed:", err);
      renderResults([]);
    }
  }

  // ── Render results ───────────────────────────────────────────────────────────

  /**
   * Clears the results list and re-renders it with the provided items.
   * Also updates the count badge and the ARIA expanded state.
   *
   * @param {Array<{tabId, title, url, faviconUrl, snippet}>} items
   */
  function renderResults(items) {
    results     = items;
    activeIndex = items.length > 0 ? 0 : -1; // Auto-select first result

    // Clear existing children
    resultsList.innerHTML = "";

    // Update ARIA state
    searchInput.setAttribute("aria-expanded", items.length > 0 ? "true" : "false");

    // Update count badge
    if (items.length > 0) {
      resultsCount.textContent = `${items.length} result${items.length !== 1 ? "s" : ""}`;
    } else {
      resultsCount.textContent = "";
    }

    if (items.length === 0) {
      const empty = document.createElement("li");
      empty.id = "empty-message";

      // Only show "no results" if the user has typed something
      if (searchInput.value.trim().length > 0) {
        empty.textContent = "No matching tabs found.";
      }

      resultsList.appendChild(empty);
      return;
    }

    // Build a list item for each result
    items.forEach((result, index) => {
      const li = createResultItem(result, index);
      resultsList.appendChild(li);
    });

    // Highlight the first item
    updateActiveItem();

    // Ensure the first item is visible (it always should be, but just in case)
    scrollActiveIntoView();
  }

  /**
   * Creates a single <li> DOM element for a result.
   *
   * @param {object} result - { tabId, title, url, faviconUrl, snippet }
   * @param {number} index  - Zero-based position in results array
   * @returns {HTMLLIElement}
   */
  function createResultItem(result, index) {
    const li = document.createElement("li");
    li.className = "result-item";
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", "false");
    li.dataset.index = index;

    // ── Top row: favicon + title + URL ────────────────────────────────────
    const topRow = document.createElement("div");
    topRow.className = "result-top";

    // Favicon
    const favicon = document.createElement("img");
    favicon.className = "result-favicon";
    favicon.width  = 16;
    favicon.height = 16;
    favicon.alt    = "";
    favicon.setAttribute("aria-hidden", "true");

    if (result.faviconUrl) {
      favicon.src = result.faviconUrl;
      // On error (expired/missing favicon), replace with a generic globe icon
      favicon.onerror = () => {
        favicon.src = getFallbackFaviconSVG();
        favicon.onerror = null;
      };
    } else {
      favicon.src = getFallbackFaviconSVG();
    }

    // Title
    const title = document.createElement("span");
    title.className   = "result-title";
    title.textContent = result.title || "Untitled Tab";

    // URL (show just the hostname + pathname for brevity)
    const urlSpan = document.createElement("span");
    urlSpan.className = "result-url";
    urlSpan.textContent = formatUrl(result.url);
    urlSpan.title = result.url; // Show full URL on hover

    topRow.appendChild(favicon);
    topRow.appendChild(title);
    topRow.appendChild(urlSpan);

    // ── Snippet ────────────────────────────────────────────────────────────
    const snippet = document.createElement("p");
    snippet.className   = "result-snippet";
    snippet.textContent = result.snippet || "";

    li.appendChild(topRow);
    li.appendChild(snippet);

    // ── Click handler ──────────────────────────────────────────────────────
    li.addEventListener("click", () => {
      switchToTab(result.tabId);
    });

    // ── Mouse hover syncs the active index ────────────────────────────────
    li.addEventListener("mouseenter", () => {
      activeIndex = index;
      updateActiveItem();
    });

    return li;
  }

  // ── Keyboard navigation ──────────────────────────────────────────────────────

  /**
   * Handles all keyboard events on the search input.
   *
   * ArrowDown / ArrowUp → move active selection
   * Enter               → switch to the highlighted tab
   * Escape              → close the overlay
   *
   * @param {KeyboardEvent} e
   */
  function onKeyDown(e) {
    switch (e.key) {

      case "ArrowDown":
        e.preventDefault(); // Don't scroll the iframe
        if (results.length === 0) return;
        activeIndex = (activeIndex + 1) % results.length;
        updateActiveItem();
        scrollActiveIntoView();
        break;

      case "ArrowUp":
        e.preventDefault();
        if (results.length === 0) return;
        activeIndex = (activeIndex - 1 + results.length) % results.length;
        updateActiveItem();
        scrollActiveIntoView();
        break;

      case "Enter":
        e.preventDefault();
        if (activeIndex >= 0 && results[activeIndex]) {
          switchToTab(results[activeIndex].tabId);
        }
        break;

      case "Escape":
        e.preventDefault();
        closeOverlay();
        break;

      default:
        break;
    }
  }

  /**
   * Updates the CSS class and ARIA attributes on all result items
   * to reflect the current activeIndex.
   */
  function updateActiveItem() {
    const items = resultsList.querySelectorAll(".result-item");
    items.forEach((item, i) => {
      const isActive = i === activeIndex;
      item.classList.toggle("is-active", isActive);
      item.setAttribute("aria-selected", isActive ? "true" : "false");
    });
  }

  /**
   * Scrolls the currently active result item into view within the list.
   */
  function scrollActiveIntoView() {
    const items = resultsList.querySelectorAll(".result-item");
    const activeItem = items[activeIndex];
    if (activeItem) {
      activeItem.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  // ── Tab switching ────────────────────────────────────────────────────────────

  /**
   * Tells the background SW to focus a specific tab, then closes the overlay.
   *
   * @param {number} tabId
   */
  async function switchToTab(tabId) {
    try {
      await chrome.runtime.sendMessage({
        type: "SWITCH_TAB",
        tabId
      });
    } catch (err) {
      console.warn("[TabLens Overlay] SWITCH_TAB failed:", err);
    } finally {
      // Always close the overlay regardless of whether the switch succeeded
      closeOverlay();
    }
  }

  // ── Overlay close ────────────────────────────────────────────────────────────

  /**
   * Instructs content.js (the parent frame) to remove the overlay iframe
   * by sending a postMessage. content.js listens for CLOSE_OVERLAY.
   */
  function closeOverlay() {
    window.parent.postMessage({ type: "CLOSE_OVERLAY" }, "*");
  }

  // ── Utility helpers ──────────────────────────────────────────────────────────

  /**
   * Formats a full URL down to just "hostname/pathname" for display.
   * Falls back to the raw URL string if parsing fails.
   *
   * @param {string} url
   * @returns {string}
   */
  function formatUrl(url) {
    if (!url) return "";
    try {
      const { hostname, pathname } = new URL(url);
      const path = pathname.length > 1
        ? pathname.slice(0, 30) + (pathname.length > 30 ? "…" : "")
        : "";
      return hostname + path;
    } catch {
      return url.slice(0, 50);
    }
  }

  /**
   * Returns a data URI for a simple grey globe SVG to use as a favicon fallback.
   * Inline SVG avoids any network request and works in extension pages.
   *
   * @returns {string} data URI
   */
  function getFallbackFaviconSVG() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
      fill="none" stroke="#7f849c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
    </svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

})();