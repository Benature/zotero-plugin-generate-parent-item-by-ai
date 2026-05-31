export function registerPreferencesAPI(): void {
  (addon.api as Record<string, unknown>).preferences = { testConnection };
}

async function testConnection(): Promise<string> {
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

  if (!baseURL) {
    return "Base URL is not set.";
  }
  if (!apiKey) {
    return "API Key is not set.";
  }

  const endpoint = `${baseURL.replace(/\/+$/, "")}/models`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
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
  const modelList: string[] = [];
  if (json && Array.isArray(json.data)) {
    for (const entry of json.data as Array<Record<string, unknown>>) {
      if (typeof entry.id === "string") {
        modelList.push(entry.id);
      }
    }
  }

  const modelFound = model && modelList.includes(model);
  if (modelList.length === 0) {
    return "Connected. (No model list returned)";
  }
  if (!model) {
    return `Connected. Available models: ${modelList.slice(0, 5).join(", ")}${modelList.length > 5 ? ` (+${modelList.length - 5} more)` : ""}`;
  }
  if (modelFound) {
    return `Connected. Model "${model}" found.`;
  }
  return `Connected, but model "${model}" not found in list. Available: ${modelList.slice(0, 3).join(", ")}${modelList.length > 3 ? "…" : ""}`;
}
