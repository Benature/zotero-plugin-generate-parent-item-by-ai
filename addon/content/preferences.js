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

  const DEFAULT_BASE_URLS = {
    openai: "https://api.openai.com/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta",
    claude: "https://api.anthropic.com/v1",
    antigravity: "https://cloudcode-pa.googleapis.com",
  };

  const KNOWN_DEFAULT_BASE_URLS = new Set(Object.values(DEFAULT_BASE_URLS));

  const DEFAULT_FORMAT_MODELS = {
    openai: ["gpt-4o-mini", "gpt-4o", "o3-mini", "gpt-4-turbo"],
    gemini: [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-1.5-flash",
      "gemini-1.5-pro",
    ],
    claude: [
      "claude-3-7-sonnet-20250219",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
    ],
    antigravity: [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "claude-3-7-sonnet",
    ],
  };

  let cachedModels = [];

  function populateModels(models, explicitSelected) {
    const popup = document.getElementById("pig-model-popup");
    const menulist = document.getElementById("pig-model");
    if (!popup || !menulist) return;

    if (Array.isArray(models) && models.length > 0) {
      cachedModels = models;
    }

    const currentFormat = String(getPref("apiFormat") ?? "openai");
    const savedModel = String(
      explicitSelected !== undefined ? explicitSelected : (getPref("model") ?? ""),
    ).trim();

    let displayList =
      cachedModels.length > 0
        ? [...cachedModels]
        : [...(DEFAULT_FORMAT_MODELS[currentFormat] || DEFAULT_FORMAT_MODELS.openai)];

    if (savedModel && !displayList.includes(savedModel)) {
      displayList.unshift(savedModel);
    }

    while (popup.firstChild) {
      popup.removeChild(popup.firstChild);
    }

    for (const m of displayList) {
      const item = createXULEl("menuitem");
      item.setAttribute("label", m);
      item.setAttribute("value", m);
      popup.appendChild(item);
    }

    const separator = createXULEl("menuseparator");
    popup.appendChild(separator);

    const customItem = createXULEl("menuitem");
    customItem.setAttribute("label", "Custom… / 自定义…");
    customItem.setAttribute("value", "__custom__");
    popup.appendChild(customItem);

    const targetModel = savedModel || displayList[0] || "";
    const allItems = popup.querySelectorAll("menuitem");
    let foundIndex = -1;
    for (let i = 0; i < allItems.length; i++) {
      if (allItems[i].getAttribute("value") === targetModel) {
        foundIndex = i;
        break;
      }
    }

    if (foundIndex >= 0) {
      menulist.selectedIndex = foundIndex;
      menulist.value = targetModel;
    } else if (allItems.length > 0) {
      menulist.selectedIndex = 0;
      menulist.value = allItems[0].getAttribute("value") || "";
    }

    if (!savedModel && menulist.value && menulist.value !== "__custom__") {
      setPref("model", menulist.value);
    }
  }

  function setTestResult(text) {
    const resultEl = document.getElementById("pig-test-result");
    if (!resultEl) return;
    resultEl.removeAttribute("value");
    resultEl.textContent = text || "";
    if (text) {
      resultEl.setAttribute("tooltiptext", text);
      resultEl.title = text;
    } else {
      resultEl.removeAttribute("tooltiptext");
      resultEl.removeAttribute("title");
    }
  }

  let isFetchingModels = false;

  async function fetchModels(options = {}) {
    const silent = Boolean(options.silent);
    if (isFetchingModels) return;

    const baseURL = String(getPref("baseURL") ?? "").trim();
    const apiKey = String(getPref("apiKey") ?? "").trim();
    if (!baseURL || !apiKey) {
      if (!silent) {
        setTestResult(!baseURL ? "Base URL is not set." : "API Key is not set.");
      }
      return;
    }

    const refreshBtn = document.getElementById("pig-refresh-models-btn");

    try {
      isFetchingModels = true;
      if (refreshBtn) refreshBtn.disabled = true;
      if (!silent) {
        setTestResult("Fetching models\u2026");
      }

      const api = Zotero["__addonInstance__"]?.api?.preferences;
      if (!api) return;

      const res = await api.testConnection();
      const modelList = Array.isArray(res?.models) ? res.models : [];

      if (modelList.length > 0) {
        populateModels(modelList);
        if (!silent) {
          setTestResult(`Connected. Fetched ${modelList.length} models.`);
        }
      } else if (!silent) {
        setTestResult(res?.message || "Connected. (No models returned)");
      }
    } catch (err) {
      if (!silent) {
        setTestResult(`Failed to fetch models: ${err.message}`);
      }
    } finally {
      isFetchingModels = false;
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  function autoFetchModels() {
    const baseURL = String(getPref("baseURL") ?? "").trim();
    const apiKey = String(getPref("apiKey") ?? "").trim();
    if (baseURL && apiKey) {
      fetchModels({ silent: true });
    }
  }

  // ---------- load / save prefs for text fields ----------

  function loadPrefs() {
    const apiFormatList = document.getElementById("pig-api-format");
    if (apiFormatList) {
      const savedFormat = String(getPref("apiFormat") ?? "openai");
      const popup = document.getElementById("pig-api-format-popup");
      if (popup) {
        const items = popup.querySelectorAll("menuitem");
        for (let i = 0; i < items.length; i++) {
          if (items[i].getAttribute("value") === savedFormat) {
            apiFormatList.selectedIndex = i;
            break;
          }
        }
      }
    }

    const fields = [
      ["pig-base-url", "baseURL"],
      ["pig-api-key", "apiKey"],
      ["pig-system-prompt", "systemPrompt"],
      ["pig-user-prompt", "userPromptTemplate"],
    ];
    for (const [id, key] of fields) {
      const el = document.getElementById(id);
      if (el) {
        el.value = String(getPref(key) ?? "");
      }
    }

    populateModels();
  }

  function setHintText() {
    const hint = document.getElementById("pig-user-prompt-hint");
    if (hint) {
      hint.textContent =
        "Placeholders: {filename}, {firstPage}, {lastPage}, {itemTypes}, {forcedItemType}";
    }
  }

  function attachListeners() {
    const apiFormatList = document.getElementById("pig-api-format");
    if (apiFormatList) {
      apiFormatList.addEventListener("command", () => {
        const newFormat = apiFormatList.value || "openai";
        setPref("apiFormat", newFormat);

        const urlInput = document.getElementById("pig-base-url");
        if (urlInput) {
          const currentUrl = urlInput.value.trim();
          if (!currentUrl || KNOWN_DEFAULT_BASE_URLS.has(currentUrl)) {
            const defaultUrl =
              DEFAULT_BASE_URLS[newFormat] || DEFAULT_BASE_URLS.openai;
            urlInput.value = defaultUrl;
            setPref("baseURL", defaultUrl);
          }
        }
        cachedModels = [];
        populateModels([], getPref("model"));
        autoFetchModels();
      });
    }

    const textFields = [
      ["pig-base-url", "baseURL"],
      ["pig-api-key", "apiKey"],
      ["pig-system-prompt", "systemPrompt"],
      ["pig-user-prompt", "userPromptTemplate"],
    ];
    for (const [id, key] of textFields) {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("change", () => {
          setPref(key, el.value.trim());
          if (key === "baseURL" || key === "apiKey") {
            autoFetchModels();
          }
        });
      }
    }

    const modelList = document.getElementById("pig-model");
    if (modelList) {
      modelList.addEventListener("command", () => {
        const val = modelList.value;
        if (val === "__custom__") {
          const current = String(getPref("model") ?? "");
          const entered = (
            window.prompt(
              "Enter model name / 请输入自定义模型名称:",
              current,
            ) || ""
          ).trim();
          if (entered) {
            setPref("model", entered);
            populateModels(cachedModels, entered);
          } else {
            populateModels(cachedModels, current);
          }
          return;
        }
        setPref("model", val);
      });
    }

    const refreshBtn = document.getElementById("pig-refresh-models-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("command", () => {
        fetchModels({ silent: false });
      });
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
    setTestResult("\u2026");
    try {
      const api = Zotero["__addonInstance__"]?.api?.preferences;
      if (!api) throw new Error("Plugin API not available.");
      const res = await api.testConnection();
      const msg = typeof res === "string" ? res : res?.message ?? "";
      setTestResult(msg);
      const modelList = Array.isArray(res?.models) ? res.models : [];
      if (modelList.length > 0) {
        populateModels(modelList);
      }
    } catch (e) {
      setTestResult(`Error: ${e.message}`);
    }
  }

  // ---------- init ----------

  function runInit() {
    if (populateItemTypes()) {
      loadPrefs();
      setHintText();
      attachListeners();
      autoFetchModels();
      return;
    }

    // Pane fragment not yet inserted — observe until it appears
    const observer = new MutationObserver(() => {
      if (populateItemTypes()) {
        observer.disconnect();
        loadPrefs();
        setHintText();
        attachListeners();
        autoFetchModels();
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
