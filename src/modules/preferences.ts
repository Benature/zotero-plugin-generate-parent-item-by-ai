export interface ConnectionTestResult {
  message: string;
  models: string[];
}

export function registerPreferencesAPI(): void {
  (addon.api as Record<string, unknown>).preferences = {
    fetchModelList,
    testConnection,
  };
}

async function fetchModelList(): Promise<string[]> {
  const res = await testConnection();
  return res.models;
}

async function testConnection(): Promise<ConnectionTestResult> {
  const prefix = addon.data.config.prefsPrefix;
  const baseURL = String(
    Zotero.Prefs.get(`${prefix}.baseURL`, true) ?? "",
  ).trim();
  const apiKey = String(
    Zotero.Prefs.get(`${prefix}.apiKey`, true) ?? "",
  ).trim();
  const model = String(
    Zotero.Prefs.get(`${prefix}.model`, true) ?? "",
  ).trim();
  const apiFormat = String(
    Zotero.Prefs.get(`${prefix}.apiFormat`, true) ?? "openai",
  ).trim();

  if (!baseURL) {
    return { message: "Base URL is not set.", models: [] };
  }
  if (!apiKey) {
    return { message: "API Key is not set.", models: [] };
  }

  const cleanBase = baseURL.replace(/\/+$/, "");
  let endpoint = `${cleanBase}/models`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiFormat === "gemini") {
    headers["x-goog-api-key"] = apiKey;
    headers["Authorization"] = `Bearer ${apiKey}`;
    if (!endpoint.includes("key=")) {
      const delimiter = endpoint.includes("?") ? "&" : "?";
      endpoint = `${endpoint}${delimiter}key=${encodeURIComponent(apiKey)}`;
    }
  } else if (apiFormat === "claude") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (apiFormat === "antigravity") {
    headers["Authorization"] = `Bearer ${apiKey}`;
    headers["x-goog-api-key"] = apiKey;
  } else {
    // openai
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers,
      method: "GET",
    });
  } catch (err) {
    throw new Error(
      `Network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Server returned ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }

  const json = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const modelList = extractModelList(json);

  const cleanModel = model.replace(/^models\//, "");
  const modelFound =
    Boolean(model) &&
    (modelList.includes(model) ||
      modelList.includes(cleanModel) ||
      modelList.some(
        (m) => m.toLowerCase() === cleanModel.toLowerCase(),
      ));

  if (modelList.length === 0) {
    return {
      message: "Connected. (No model list returned)",
      models: [],
    };
  }

  const allModelsStr = modelList.join(", ");

  if (!model) {
    return {
      message: `Connected. Available models (${modelList.length}): ${allModelsStr}`,
      models: modelList,
    };
  }
  if (modelFound) {
    return {
      message: `Connected. Model "${model}" found. Available models (${modelList.length}): ${allModelsStr}`,
      models: modelList,
    };
  }
  return {
    message: `Connected, but model "${model}" not found in list. Available models (${modelList.length}): ${allModelsStr}`,
    models: modelList,
  };
}

function extractModelList(json: Record<string, unknown> | null): string[] {
  if (!json) return [];
  const modelSet = new Set<string>();
  const rawList = Array.isArray(json.data)
    ? json.data
    : Array.isArray(json.models)
      ? json.models
      : [];

  for (const entry of rawList as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== "object") continue;
    const rawName =
      typeof entry.id === "string"
        ? entry.id.trim()
        : typeof entry.name === "string"
          ? entry.name.trim()
          : "";
    if (!rawName) continue;
    const cleanName = rawName.replace(/^models\//, "");
    modelSet.add(cleanName);
  }
  return Array.from(modelSet);
}
