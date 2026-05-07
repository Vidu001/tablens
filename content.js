/**
 * content.js — TabLens Content Script
 *
 * Injected into every accessible tab. Responsible for:
 *   1. Extracting the page's visible text and sending it to the background SW.
 *   2. Managing the overlay iframe lifecycle (show / hide).
 *   3. Listening for the TOGGLE_OVERLAY message from the background SW.
 *   4. Supporting triple-click as an alternative overlay trigger.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Guard against duplicate injection
// ─────────────────────────────────────────────────────────────────────────────

if (window.__tabLensInjected) {
  // Already injected — do nothing
} else {
  window.__tabLensInjected = true;
  initTabLens();
}

/**
 * Main initialisation function.
 */
function initTabLens() {

  // ───────────────────────────────────────────────────────────────────────────
  // Constants
  // ───────────────────────────────────────────────────────────────────────────

  const CONTAINER_ID   = "tablens-overlay-container";
  const MAX_TEXT_CHARS = 50_000;

  // ───────────────────────────────────────────────────────────────────────────
  // 1. PAGE TEXT EXTRACTION + INDEXING
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Sends page text to the background service worker.
   */
  function sendPageText() {
    try {
      const rawText = document.body?.innerText ?? "";
      const text    = rawText.slice(0, MAX_TEXT_CHARS);

      console.log("[TabLens] Indexed:", location.href);
      console.log("[TabLens] Text length:", text.length);

      chrome.runtime.sendMessage({
        type: "PAGE_TEXT",
        text
      });

    } catch (err) {
      console.debug("[TabLens] sendPageText failed:", err);
    }
  }

  /**
   * Wait until the page has meaningful visible text before indexing.
   * Helps with React/Vue/SPAs and lazy-loaded pages.
   */
  function waitForPageReadyAndSend() {

    const trySend = () => {
      const text = document.body?.innerText?.trim() || "";

      // Avoid indexing nearly-empty pages
      if (text.length > 100) {
        sendPageText();
        return true;
      }

      return false;
    };

    // Try immediately first
    if (trySend()) return;

    // Retry several times because many modern pages render asynchronously
    let attempts = 0;

    const interval = setInterval(() => {
      attempts++;

      if (trySend() || attempts >= 10) {
        clearInterval(interval);
      }
    }, 500);
  }

  // Start indexing flow
  if (document.readyState === "complete") {
    waitForPageReadyAndSend();
  } else {
    window.addEventListener(
      "load",
      waitForPageReadyAndSend,
      { once: true }
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Optional SPA auto-reindexing
  // ───────────────────────────────────────────────────────────────────────────

  let reindexDebounce;

  const observer = new MutationObserver(() => {
    clearTimeout(reindexDebounce);

    reindexDebounce = setTimeout(() => {
      sendPageText();
    }, 1000);
  });

  // Start observing once body exists
  const startObserver = () => {
    if (!document.body) return;

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  };

  if (document.body) {
    startObserver();
  } else {
    window.addEventListener("load", startObserver, { once: true });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Triple-click listener
  // ───────────────────────────────────────────────────────────────────────────

  document.addEventListener("click", (e) => {
    if (e.detail === 3) {
      toggleOverlay();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Message listener
  // ───────────────────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "TOGGLE_OVERLAY") {
      toggleOverlay();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Overlay lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  function toggleOverlay() {
    const existing = document.getElementById(CONTAINER_ID);

    if (existing) {
      removeOverlay();
    } else {
      showOverlay();
    }
  }

  /**
   * Creates and mounts overlay iframe.
   */
  async function showOverlay() {

    let overlayUrl;

    try {
      const response = await chrome.runtime.sendMessage({
        type: "GET_OVERLAY_URL"
      });

      overlayUrl = response?.url;

    } catch {
      console.warn("[TabLens] Could not resolve overlay URL.");
      return;
    }

    if (!overlayUrl) return;

    // ── Backdrop container ──────────────────────────────────────────────────

    const container = document.createElement("div");
    container.id = CONTAINER_ID;

    Object.assign(container.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "center",
      paddingTop: "80px",
      backgroundColor: "rgba(0, 0, 0, 0.55)",
      backdropFilter: "blur(4px)",
      WebkitBackdropFilter: "blur(4px)"
    });

    // ── iframe ──────────────────────────────────────────────────────────────

    const iframe = document.createElement("iframe");

    iframe.src       = overlayUrl;
    iframe.id        = "tablens-overlay-iframe";
    iframe.scrolling = "no";

    iframe.setAttribute("frameborder", "0");

    Object.assign(iframe.style, {
      width: "620px",
      maxWidth: "calc(100vw - 32px)",
      maxHeight: "520px",
      border: "none",
      borderRadius: "14px",
      overflow: "hidden",
      background: "transparent",
      boxShadow:
        "0 24px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.06)"
    });

    // ── Close on backdrop click ────────────────────────────────────────────

    container.addEventListener("click", (e) => {
      if (e.target === container) {
        removeOverlay();
      }
    });

    // ── iframe communication ───────────────────────────────────────────────

    window.addEventListener("message", onIframeMessage);

    iframe.addEventListener("load", () => {
      setTimeout(() => {
        try {
          iframe.contentWindow?.postMessage(
            { type: "FOCUS_INPUT" },
            "*"
          );
        } catch {}
      }, 30);
    });

    container.appendChild(iframe);
    document.documentElement.appendChild(container);
  }

  /**
   * Handles messages from overlay iframe.
   */
  function onIframeMessage(event) {
    if (event.data?.type === "CLOSE_OVERLAY") {
      removeOverlay();
    }
  }

  /**
   * Removes overlay from DOM.
   */
  function removeOverlay() {

    const container = document.getElementById(CONTAINER_ID);

    if (container) {
      container.remove();
    }

    window.removeEventListener("message", onIframeMessage);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Escape key fallback
  // ───────────────────────────────────────────────────────────────────────────

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const container = document.getElementById(CONTAINER_ID);

      if (container) {
        removeOverlay();
      }
    }
  });

}