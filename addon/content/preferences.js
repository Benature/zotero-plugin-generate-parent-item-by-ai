// Runs in the Zotero preferences pane document context.
// Build-time tokens (__addonRef__, __addonInstance__, __prefsPrefix__) are
// replaced by zotero-plugin-scaffold during the build step.
(function () {
  "use strict";

  const PREFS_PREFIX = "__prefsPrefix__";
  const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

  // ---------- pref helpers ----------

  function getPref(key) {
    try {
      return Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true);
    } catch (_e) {
      return undefined;
    }
  }

  function setPref(key, value) {
    try {
      Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true);
    } catch (e) {
      Zotero.logError(e);
    }
  }

  // ---------- element helpers ----------

  function createXULEl(tag) {
    return document.createElementNS(XUL_NS, tag);
  }

  /** Convert camelCase type name to a readable label. */
  function typeToLabel(name) {
    return name
      .replace(/([A-Z])/g, " $1")
      .replace(/^(.)/, (c) => c.toUpperCase())
      .trim();
  }

  // ---------- populate item-types dropdown ----------

  /** Fallback list used when Zotero.ItemTypes is unavailable. */
  const BASIC_TYPES = [
    "bookSection",
    "book",
    "conferencePaper",
    "document",
    "journalArticle",
    "preprint",
    "report",
    "thesis",
    "webpage",
  ];

  /**
   * Populate the "Forced Item Type" menulist.
   * Returns true if the popup element was found (regardless of whether
   * Zotero type data was available), false if the element isn't in the
   * DOM yet.
   */
  function populateItemTypes() {
    const popup = document.getElementById("pig-forced-item-type-popup");
    if (!popup) return false;

    // Clear existing children
    while (popup.firstChild) {
      popup.removeChild(popup.firstChild);
    }

    // "Auto" entry
    const autoItem = createXULEl("menuitem");
    autoItem.setAttribute("label", "Auto (let AI decide)");
    autoItem.setAttribute("value", "");
    popup.appendChild(autoItem);

    // Zotero item types
    let typeNames = BASIC_TYPES;
    try {
      const raw = Zotero.ItemTypes.getTypes();
      // getTypes() may be synchronous (array) or async (Promise)
      if (Array.isArray(raw) && raw.length > 0) {
        typeNames = raw.map((t) => t.name);
      }
    } catch (_e) {
      // fall through to BASIC_TYPES
    }

    const sorted = [...typeNames].sort((a, b) =>
      typeToLabel(a).localeCompare(typeToLabel(b)),
    );

    for (const name of sorted) {
      const item = createXULEl("menuitem");
      item.setAttribute("label", typeToLabel(name));
      item.setAttribute("value", name);
      popup.appendChild(item);
    }

    // Restore saved selection
    const menulist = document.getElementById("pig-forced-item-type");
    if (menulist) {
      const saved = String(getPref("forcedItemType") ?? "");
      const allItems = popup.querySelectorAll("menuitem");
      let found = false;
      for (let i = 0; i < allItems.length; i++) {
        if (allItems[i].getAttribute("value") === saved) {
          menulist.selectedIndex = i;
          found = true;
          break;
        }
      }
      if (!found) {
        menulist.selectedIndex = 0;
      }
    }

    return true;
  }

  // ---------- load / save prefs for text fields ----------

  function loadPrefs() {
    const fields = [
      ["pig-base-url", "baseURL"],
      ["pig-api-key", "apiKey"],
      ["pig-model", "model"],
      ["pig-system-prompt", "systemPrompt"],
      ["pig-user-prompt", "userPromptTemplate"],
    ];
    for (const [id, key] of fields) {
      const el = document.getElementById(id);
      if (el) {
        el.value = String(getPref(key) ?? "");
      }
    }
  }

  function setHintText() {
    const hint = document.getElementById("pig-user-prompt-hint");
    if (hint) {
      hint.textContent =
        "Placeholders: {filename}, {firstPage}, {lastPage}, {itemTypes}, {forcedItemType}";
    }
  }

  function attachListeners() {
    const textFields = [
      ["pig-base-url", "baseURL"],
      ["pig-api-key", "apiKey"],
      ["pig-model", "model"],
      ["pig-system-prompt", "systemPrompt"],
      ["pig-user-prompt", "userPromptTemplate"],
    ];
    for (const [id, key] of textFields) {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("change", () => setPref(key, el.value));
      }
    }

    const menulist = document.getElementById("pig-forced-item-type");
    if (menulist) {
      menulist.addEventListener("command", () =>
        setPref("forcedItemType", menulist.value),
      );
    }

    const testBtn = document.getElementById("pig-test-btn");
    if (testBtn) {
      testBtn.addEventListener("command", handleTestConnection);
    }
  }

  // ---------- test connection ----------

  async function handleTestConnection() {
    const resultEl = document.getElementById("pig-test-result");
    if (resultEl) resultEl.value = "\u2026";
    try {
      const api = Zotero["__addonInstance__"]?.api?.preferences;
      if (!api) throw new Error("Plugin API not available.");
      const msg = await api.testConnection();
      if (resultEl) resultEl.value = msg;
    } catch (e) {
      if (resultEl) resultEl.value = `Error: ${e.message}`;
    }
  }

  // ---------- init ----------

  function runInit() {
    if (populateItemTypes()) {
      loadPrefs();
      setHintText();
      attachListeners();
      return;
    }

    // Pane fragment not yet inserted — observe until it appears
    const observer = new MutationObserver(() => {
      if (populateItemTypes()) {
        observer.disconnect();
        loadPrefs();
        setHintText();
        attachListeners();
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    // Safety disconnect after 10 s
    setTimeout(() => observer.disconnect(), 10000);
  }

  function initPane() {
    // Load FTL — suppress both sync throws and async rejections
    try {
      const ftl =
        document.ownerGlobal?.MozXULElement?.insertFTLIfNeeded?.(
          "__addonRef__-preferences.ftl",
        );
      if (ftl && typeof ftl.catch === "function") {
        ftl.catch(() => {});
      }
    } catch (_e) {}

    // Defer one tick so the pane fragment can be inserted first
    (document.ownerGlobal?.setTimeout ?? setTimeout)(runInit, 0);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPane);
  } else {
    initPane();
  }
})();
