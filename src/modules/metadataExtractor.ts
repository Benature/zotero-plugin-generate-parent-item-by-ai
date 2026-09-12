export type PDFTextSample = {
  attachmentTitle: string;
  filename: string;
  firstPageText: string;
  lastPageText: string;
  pageCount: number;
  pagesExtracted: boolean;
};

type LLMSettings = {
  apiFormat: string;
  apiKey: string;
  baseURL: string;
  model: string;
  forcedItemType: string;
  systemPrompt: string;
  userPromptTemplate: string;
};

export type CreatorEntry = {
  creatorType: string;
  firstName: string;
  lastName: string;
};

export type ParsedMetadata = {
  itemType: string;
  fields: Record<string, string>;
  creators: CreatorEntry[];
  tags: string[];
  reason: string;
};

type PDFWorkerFullTextResult = {
  content?: string;
  extractedPages?: number;
  pages?: string[];
  text?: string;
  totalPages?: number;
};

export type ExtractionProgress = {
  message: string;
  percent: number;
};

export type ExtractionProgressReporter = (progress: ExtractionProgress) => void;

export type MetadataDraft = {
  metadata: ParsedMetadata;
  sample: PDFTextSample;
};

const MAX_PAGE_TEXT_CHARS = 12000;

const INSTITUTION_FIELDS = new Set([
  "institution",
  "university",
  "publisher",
  "company",
  "publicationTitle",
  "conferenceName",
  "proceedingsTitle",
  "repository",
]);

function isMetadataComplete(metadata: ParsedMetadata): boolean {
  if (!metadata.itemType.trim()) return false;
  if (!metadata.fields.title?.trim()) return false;
  if (!metadata.fields.date?.trim()) return false;

  const hasCreator = metadata.creators.some(
    (c) => Boolean(c.firstName.trim() || c.lastName.trim()),
  );
  if (!hasCreator) return false;

  const hasInstitution = Object.entries(metadata.fields).some(
    ([key, value]) => INSTITUTION_FIELDS.has(key) && Boolean(value?.trim()),
  );
  if (!hasInstitution) return false;

  return true;
}

export const DEFAULT_SYSTEM_PROMPT = `You are a document metadata extraction assistant for Zotero. \
Based on the PDF filename, Zotero title, and page text, identify the Zotero item type and \
extract structured metadata.

Return ONLY a raw JSON object (no Markdown, no extra text) with these fields:
- itemType: the Zotero item type name (e.g. "journalArticle", "book", "report", "thesis", \
"conferencePaper", "preprint", "webpage", "bookSection", "document")
- fields: object mapping Zotero field names to string values suitable for the chosen itemType; \
omit fields that are unknown or not applicable
- creators: array of {creatorType, firstName, lastName}; for single-component names put the \
full name in lastName and leave firstName empty
- tags: array of tag strings (usually empty unless clearly indicated in the document)
- reason: brief explanation if the item type or key metadata is uncertain; empty string if confident

Common Zotero fields by type:
  journalArticle: title, date, publicationTitle, volume, issue, pages, DOI, ISSN, abstractNote
  report: title, date, reportType, reportNumber, institution, place, seriesTitle, seriesNumber, pages, DOI, url
  book: title, date, publisher, place, ISBN, numPages, edition, series, seriesNumber
  thesis: title, date, university, thesisType, numPages
  conferencePaper: title, date, conferenceName, proceedingsTitle, pages, DOI, series
  preprint: title, date, repository, DOI, series, seriesNumber
  bookSection: title, date, bookTitle, publisher, place, pages, series, seriesNumber
  webpage: title, date, websiteTitle, url, accessDate

CRITICAL FIELD RULES:
1. Field names must use exact Zotero camelCase (e.g. "seriesTitle", "seriesNumber", "reportNumber", "reportType"). Do NOT use spaces or snake_case.
2. For "report" items, the series title MUST be placed in "seriesTitle" and series number in "seriesNumber" (and report number in "reportNumber"). NEVER put seriesTitle, seriesNumber, or reportNumber in the "extra" field.
3. The "extra" field is strictly reserved for metadata that has no native Zotero field.`;

export const DEFAULT_USER_PROMPT_TEMPLATE = `Please identify the item type and extract metadata.

Filename: {filename}

Available item types and fields:
{itemTypes}
{forcedItemType}
First page text:
{firstPage}

Last page text:
{lastPage}

Return only this JSON structure (fill in the values):
{"itemType":"","fields":{"title":"","date":""},"creators":[{"creatorType":"author","firstName":"","lastName":""}],"tags":[],"reason":""}`;

export function isStandalonePDFAttachment(item: unknown): item is ZoteroItem {
  const maybeItem = item as Partial<ZoteroItem> | undefined;
  const isAttachment =
    typeof maybeItem?.isAttachment === "function" && maybeItem.isAttachment();
  const isPDF =
    (typeof maybeItem?.isPDF === "function" && maybeItem.isPDF()) ||
    (typeof maybeItem?.isPDFAttachment === "function" &&
      maybeItem.isPDFAttachment()) ||
    maybeItem?.attachmentContentType === "application/pdf" ||
    (typeof maybeItem?.attachmentFilename === "string" &&
      maybeItem.attachmentFilename.toLowerCase().endsWith(".pdf"));
  const hasParent = Boolean(
    maybeItem?.parentID || maybeItem?.parentItemID || maybeItem?.parentItem,
  );

  return Boolean(maybeItem && isAttachment && isPDF && !hasParent);
}

export async function generateParentItemFromPDF(
  pdfItem: ZoteroItem,
  onProgress?: ExtractionProgressReporter,
): Promise<ZoteroItem> {
  const draft = await extractMetadataDraftFromPDF(pdfItem, onProgress);
  onProgress?.({ message: "Creating Zotero parent item", percent: 85 });
  return createParentItemFromMetadata(pdfItem, draft.metadata);
}

export async function extractMetadataDraftFromPDF(
  pdfItem: ZoteroItem,
  onProgress?: ExtractionProgressReporter,
): Promise<MetadataDraft> {
  if (!isStandalonePDFAttachment(pdfItem)) {
    throw new Error("Select exactly one standalone PDF attachment.");
  }

  onProgress?.({ message: "Extracting filename context", percent: 10 });
  let sample = await buildFilenameOnlySample(pdfItem);

  onProgress?.({ message: "Calling AI for initial identification", percent: 20 });
  let metadata = await requestMetadata(sample, undefined, undefined, true);

  if (!isMetadataComplete(metadata)) {
    Zotero.debug(
      "Parent Item Generator: phase-1 metadata incomplete, extracting PDF page text",
    );
    sample = await extractPageText(pdfItem, sample, onProgress);
    onProgress?.({ message: "Calling AI with full page context", percent: 75 });
    metadata = await requestMetadata(sample);
  }

  return { metadata, sample };
}

export async function improveMetadataDraft(
  pdfItem: ZoteroItem,
  draft: MetadataDraft,
  feedback: string,
  onProgress?: ExtractionProgressReporter,
): Promise<MetadataDraft> {
  const trimmedFeedback = feedback.trim();
  if (!trimmedFeedback) {
    throw new Error("Improvement feedback cannot be empty.");
  }

  let { sample } = draft;
  if (!sample.pagesExtracted) {
    onProgress?.({
      message: "Extracting PDF pages for improvement context",
      percent: 20,
    });
    sample = await extractPageText(pdfItem, sample, onProgress);
  }

  onProgress?.({ message: "Improving metadata with AI feedback", percent: 75 });
  const metadata = await requestMetadata(sample, trimmedFeedback, draft.metadata);
  return { metadata, sample };
}

export async function createParentItemFromMetadata(
  pdfItem: ZoteroItem,
  metadata: ParsedMetadata,
): Promise<ZoteroItem> {
  return createParentItem(pdfItem, metadata);
}

async function buildFilenameOnlySample(
  pdfItem: ZoteroItem,
): Promise<PDFTextSample> {
  const filePath = await pdfItem.getFilePathAsync();
  if (!filePath) {
    throw new Error("The selected PDF file is missing on disk.");
  }
  return {
    attachmentTitle: getAttachmentTitle(pdfItem),
    filename: getAttachmentFilename(pdfItem, filePath),
    firstPageText: "",
    lastPageText: "",
    pageCount: 0,
    pagesExtracted: false,
  };
}

async function extractPageText(
  pdfItem: ZoteroItem,
  sample: PDFTextSample,
  onProgress?: ExtractionProgressReporter,
): Promise<PDFTextSample> {
  const filePath = await pdfItem.getFilePathAsync();
  if (!filePath) {
    throw new Error("The selected PDF file is missing on disk.");
  }

  onProgress?.({ message: "Reading PDF page count", percent: 45 });
  const firstPageInfo = await extractPDFWorkerLeadingText(pdfItem.id, 1);
  const pageCount =
    firstPageInfo.totalPages ?? firstPageInfo.extractedPages ?? 0;

  onProgress?.({ message: "Extracting first page text", percent: 55 });
  const firstPage = getPDFWorkerText(firstPageInfo);
  onProgress?.({ message: "Extracting last page text", percent: 65 });
  const lastPage =
    pageCount > 1
      ? await extractLastPDFWorkerPageText(pdfItem.id, filePath, pageCount)
      : "";

  return {
    ...sample,
    firstPageText: truncateForPrompt(firstPage),
    lastPageText: truncateForPrompt(lastPage),
    pageCount,
    pagesExtracted: true,
  };
}

async function extractPDFWorkerLeadingText(
  itemID: number,
  maxPages: number | null,
): Promise<PDFWorkerFullTextResult> {
  const result = (await Zotero.PDFWorker.getFullText(
    itemID,
    maxPages,
    true,
  )) as PDFWorkerFullTextResult;
  return result;
}

async function extractLastPDFWorkerPageText(
  itemID: number,
  filePath: string,
  pageCount: number,
): Promise<string> {
  const pdfWorker = Zotero.PDFWorker as {
    _enqueue?: <T>(fn: () => Promise<T>, isPriority?: boolean) => Promise<T>;
    _query?: (
      action: string,
      data: Record<string, unknown>,
      transfer?: Transferable[],
    ) => Promise<Record<string, any>>;
  };

  if (!pdfWorker._enqueue || !pdfWorker._query) {
    const allText = await extractPDFWorkerFullTextFallback(itemID);
    return takeTextTail(allText);
  }

  return pdfWorker._enqueue(async () => {
    const buf = await IOUtils.read(filePath);
    const arrayBuffer = new Uint8Array(buf).buffer;
    const pageIndexes = Array.from({ length: pageCount - 1 }, (_value, i) => i);
    const deleteResult = await pdfWorker._query!(
      "deletePages",
      {
        buf: arrayBuffer,
        pageIndexes,
      },
      [arrayBuffer],
    );

    const modifiedBuf = deleteResult.buf;
    if (!(modifiedBuf instanceof ArrayBuffer)) {
      return "";
    }

    const fullTextResult = (await pdfWorker._query!(
      "getFulltext",
      {
        buf: modifiedBuf,
        maxPages: 1,
      },
      [modifiedBuf],
    )) as PDFWorkerFullTextResult;

    return getPDFWorkerText(fullTextResult);
  }, true);
}

async function extractPDFWorkerFullTextFallback(itemID: number): Promise<string> {
  Zotero.debug(
    "Parent Item Generator: falling back to full PDF text tail extraction",
  );
  const result = await extractPDFWorkerLeadingText(itemID, null);
  return getPDFWorkerText(result);
}

function getPDFWorkerText(result: PDFWorkerFullTextResult): string {
  if (Array.isArray(result.pages)) {
    return normalizeWhitespace(result.pages.join("\n"));
  }
  return normalizeWhitespace(result.text ?? result.content ?? "");
}

function takeTextTail(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= MAX_PAGE_TEXT_CHARS) {
    return normalized;
  }
  return normalized.slice(-MAX_PAGE_TEXT_CHARS);
}

async function requestMetadata(
  sample: PDFTextSample,
  feedback?: string,
  previousMetadata?: ParsedMetadata,
  filenameOnly?: boolean,
): Promise<ParsedMetadata> {
  const settings = readLLMSettings();
  const promptText = buildPrompt(
    sample,
    settings,
    feedback,
    previousMetadata,
    filenameOnly,
  );

  let content: string;
  switch (settings.apiFormat.toLowerCase()) {
    case "gemini":
      content = await requestGemini(promptText, settings);
      break;
    case "claude":
      content = await requestClaude(promptText, settings);
      break;
    case "antigravity":
      content = await requestAntigravityInternal(promptText, settings);
      break;
    case "openai":
    default:
      content = await requestOpenAI(promptText, settings);
      break;
  }

  const parsed = parseMetadataJSON(content);
  return validateAndFilterFields(
    settings.forcedItemType
      ? { ...parsed, itemType: settings.forcedItemType }
      : parsed,
  );
}

async function requestOpenAI(
  promptText: string,
  settings: LLMSettings,
): Promise<string> {
  const endpoint = `${settings.baseURL.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content: settings.systemPrompt,
        },
        {
          role: "user",
          content: promptText,
        },
      ],
      model: settings.model,
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenAI request failed (${response.status} ${response.statusText}): ${truncateForLog(
        responseText,
      )}`,
    );
  }

  const responseJSON = parseObjectJSON(responseText, "OpenAI HTTP response");
  const content = responseJSON.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("OpenAI response did not contain choices[0].message.content.");
  }
  return content;
}

async function requestGemini(
  promptText: string,
  settings: LLMSettings,
): Promise<string> {
  const base = settings.baseURL.replace(/\/+$/, "");
  const cleanModel = settings.model.replace(/^models\//, "");
  let endpoint = base.endsWith("/models")
    ? `${base}/${encodeURIComponent(cleanModel)}:generateContent`
    : `${base}/models/${encodeURIComponent(cleanModel)}:generateContent`;

  if (settings.apiKey) {
    const separator = endpoint.includes("?") ? "&" : "?";
    endpoint += `${separator}key=${encodeURIComponent(settings.apiKey)}`;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-goog-api-key": settings.apiKey,
  };
  if (settings.apiKey) {
    headers["Authorization"] = `Bearer ${settings.apiKey}`;
  }

  const response = await fetch(endpoint, {
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: promptText }],
          role: "user",
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.2,
      },
      systemInstruction: {
        parts: [{ text: settings.systemPrompt }],
      },
    }),
    headers,
    method: "POST",
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Gemini request failed (${response.status} ${response.statusText}): ${truncateForLog(
        responseText,
      )}`,
    );
  }

  const responseJSON = parseObjectJSON(responseText, "Gemini HTTP response");
  const candidate = responseJSON.candidates?.[0];
  if (!candidate) {
    throw new Error("Gemini response did not contain any candidates.");
  }

  const parts = candidate.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("Gemini response candidate did not contain content.parts.");
  }

  const nonThoughtParts = parts.filter(
    (p: unknown) => isRecord(p) && !p.thought && typeof p.text === "string",
  );
  const selectedParts = nonThoughtParts.length > 0 ? nonThoughtParts : parts;
  const content = selectedParts
    .map((p: unknown) =>
      isRecord(p) && typeof p.text === "string" ? p.text : "",
    )
    .join("")
    .trim();

  if (!content) {
    throw new Error(
      "Gemini response did not contain text content in candidate parts.",
    );
  }
  return content;
}

async function requestClaude(
  promptText: string,
  settings: LLMSettings,
): Promise<string> {
  const endpoint = `${settings.baseURL.replace(/\/+$/, "")}/messages`;
  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
    "x-api-key": settings.apiKey,
  };
  if (settings.apiKey) {
    headers["Authorization"] = `Bearer ${settings.apiKey}`;
  }

  const response = await fetch(endpoint, {
    body: JSON.stringify({
      max_tokens: 4096,
      messages: [
        {
          content: promptText,
          role: "user",
        },
      ],
      model: settings.model,
      system: settings.systemPrompt,
      temperature: 0.2,
    }),
    headers,
    method: "POST",
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Claude request failed (${response.status} ${response.statusText}): ${truncateForLog(
        responseText,
      )}`,
    );
  }

  const responseJSON = parseObjectJSON(responseText, "Claude HTTP response");
  const contentBlocks = responseJSON.content;
  if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
    throw new Error("Claude response did not contain content blocks.");
  }

  const textBlocks = contentBlocks.filter(
    (b: unknown) => isRecord(b) && b.type === "text" && typeof b.text === "string",
  );
  const content = textBlocks
    .map((b: any) => b.text)
    .join("")
    .trim();

  if (!content) {
    throw new Error("Claude response did not contain text in content blocks.");
  }
  return content;
}

async function requestAntigravityInternal(
  promptText: string,
  settings: LLMSettings,
): Promise<string> {
  const endpoint = `${settings.baseURL.replace(/\/+$/, "")}/v1internal:generateContent`;
  const cleanModel = settings.model.replace(/^models\//, "");

  const response = await fetch(endpoint, {
    body: JSON.stringify({
      model: cleanModel,
      project: "",
      request: {
        contents: [
          {
            parts: [{ text: promptText }],
            role: "user",
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2,
        },
        systemInstruction: {
          parts: [{ text: settings.systemPrompt }],
        },
      },
      userAgent: "antigravity",
    }),
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "antigravity",
    },
    method: "POST",
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Antigravity internal request failed (${response.status} ${response.statusText}): ${truncateForLog(
        responseText,
      )}`,
    );
  }

  const responseJSON = parseObjectJSON(
    responseText,
    "Antigravity internal HTTP response",
  );
  const root = isRecord(responseJSON.response)
    ? responseJSON.response
    : responseJSON;
  const candidate = root.candidates?.[0];
  if (!candidate) {
    throw new Error("Antigravity response did not contain any candidates.");
  }

  const parts = candidate.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error(
      "Antigravity response candidate did not contain content.parts.",
    );
  }

  const nonThoughtParts = parts.filter(
    (p: unknown) => isRecord(p) && !p.thought && typeof p.text === "string",
  );
  const selectedParts = nonThoughtParts.length > 0 ? nonThoughtParts : parts;
  const content = selectedParts
    .map((p: unknown) =>
      isRecord(p) && typeof p.text === "string" ? p.text : "",
    )
    .join("")
    .trim();

  if (!content) {
    throw new Error(
      "Antigravity response did not contain text content in candidate parts.",
    );
  }
  return content;
}

function readLLMSettings(): LLMSettings {
  const prefix = addon.data.config.prefsPrefix;
  const apiFormat = String(
    Zotero.Prefs.get(`${prefix}.apiFormat`, true) ?? "openai",
  ).trim() || "openai";
  const apiKey = String(Zotero.Prefs.get(`${prefix}.apiKey`, true) ?? "").trim();
  const baseURL = String(
    Zotero.Prefs.get(`${prefix}.baseURL`, true) ?? "",
  ).trim();
  const model = String(Zotero.Prefs.get(`${prefix}.model`, true) ?? "").trim();

  const missing = [
    ["Base URL", baseURL],
    ["API Key", apiKey],
    ["Model", model],
  ]
    .filter(([, value]) => !value)
    .map(([label]) => label);

  if (missing.length) {
    throw new Error(
      `Missing preferences: ${missing.join(", ")}. Configure them in Zotero Preferences → ${addon.data.config.addonName}.`,
    );
  }

  const systemPromptRaw = String(
    Zotero.Prefs.get(`${prefix}.systemPrompt`, true) ?? "",
  ).trim();
  const userPromptTemplateRaw = String(
    Zotero.Prefs.get(`${prefix}.userPromptTemplate`, true) ?? "",
  ).trim();

  return {
    apiFormat,
    apiKey,
    baseURL,
    forcedItemType: String(
      Zotero.Prefs.get(`${prefix}.forcedItemType`, true) ?? "",
    ).trim(),
    model,
    systemPrompt: systemPromptRaw || DEFAULT_SYSTEM_PROMPT,
    userPromptTemplate: userPromptTemplateRaw || DEFAULT_USER_PROMPT_TEMPLATE,
  };
}

function describeItemTypes(forcedItemType: string): string {
  try {
    if (forcedItemType) {
      const typeID = Zotero.ItemTypes.getID(forcedItemType) as
        | number
        | undefined;
      if (!typeID) {
        return forcedItemType;
      }
      const fieldNames = (
        Zotero.ItemFields.getItemTypeFields(typeID) as number[]
      )
        .map((fid) => Zotero.ItemFields.getName(fid) as string | undefined)
        .filter((n): n is string => Boolean(n));
      return `${forcedItemType}: ${fieldNames.join(", ")}`;
    }

    const types = (Zotero.ItemTypes.getTypes() as Array<{
      hidden?: boolean;
      id: number;
      name: string;
    }>).filter((t) => !t.hidden);

    const lines: string[] = [];
    for (const type of types) {
      const fieldNames = (
        Zotero.ItemFields.getItemTypeFields(type.id) as number[]
      )
        .map((fid) => Zotero.ItemFields.getName(fid) as string | undefined)
        .filter((n): n is string => Boolean(n));
      lines.push(`${type.name}: ${fieldNames.join(", ")}`);
    }
    return lines.join("\n");
  } catch (err) {
    Zotero.logError(err);
    return "journalArticle, book, report, thesis, conferencePaper, preprint, webpage, bookSection, document";
  }
}

function buildPrompt(
  sample: PDFTextSample,
  settings: LLMSettings,
  feedback?: string,
  previousMetadata?: ParsedMetadata,
  filenameOnly?: boolean,
): string {
  const forcedNote = settings.forcedItemType
    ? `\nThe item type MUST be: ${settings.forcedItemType}\n`
    : "";

  let prompt = settings.userPromptTemplate
    .replace(/\{filename\}/g, sample.filename)
    .replace(/\{firstPage\}/g, sample.firstPageText || "(empty)")
    .replace(/\{lastPage\}/g, sample.lastPageText || "(empty)")
    .replace(/\{itemTypes\}/g, describeItemTypes(settings.forcedItemType))
    .replace(/\{forcedItemType\}/g, forcedNote);

  if (filenameOnly) {
    prompt +=
      "\n\nNote: Only the filename is available at this stage; page text has not been extracted yet. " +
      "Extract as much metadata as possible from the filename alone and set the reason field if uncertain.";
  }

  const trimmedFeedback = feedback?.trim();
  if (trimmedFeedback) {
    prompt += [
      "",
      "Previous result:",
      previousMetadata ? JSON.stringify(toLLMJSON(previousMetadata)) : "{}",
      "",
      "User feedback:",
      trimmedFeedback,
      "",
      "Please revise the JSON based on the feedback.",
    ].join("\n");
  }

  return prompt;
}

function toLLMJSON(
  metadata: ParsedMetadata,
): Record<string, unknown> {
  return {
    itemType: metadata.itemType,
    fields: metadata.fields,
    creators: metadata.creators,
    tags: metadata.tags,
    reason: metadata.reason,
  };
}

function extractJSONString(raw: string): string {
  let text = raw.trim();

  // If the whole string starts with code fence, strip outer fence
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  // If it's already a valid JSON object starting with { and ending with }
  if (text.startsWith("{") && text.endsWith("}")) {
    return text;
  }

  // Otherwise, find outermost { and }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return text.substring(firstBrace, lastBrace + 1).trim();
  }

  return text;
}

function parseMetadataJSON(content: string): ParsedMetadata {
  const jsonStr = extractJSONString(content);
  if (!jsonStr.startsWith("{") || !jsonStr.endsWith("}")) {
    throw new Error("LLM returned non-JSON content.");
  }

  const value = parseObjectJSON(jsonStr, "LLM metadata JSON");

  if (!hasOwn(value, "itemType") || typeof value.itemType !== "string") {
    throw new Error('LLM metadata JSON is missing or has invalid "itemType".');
  }
  if (!value.itemType.trim()) {
    throw new Error('LLM metadata "itemType" must not be empty.');
  }

  const fields: Record<string, string> = {};
  if (isRecord(value.fields)) {
    for (const [k, v] of Object.entries(value.fields)) {
      if (typeof v === "string") {
        fields[k] = v;
      } else if (v !== null && v !== undefined) {
        fields[k] = String(v);
      }
    }
  }

  const creators: CreatorEntry[] = [];
  if (Array.isArray(value.creators)) {
    for (const c of value.creators as unknown[]) {
      if (!isRecord(c)) continue;
      creators.push({
        creatorType: typeof c.creatorType === "string" ? c.creatorType : "author",
        firstName: typeof c.firstName === "string" ? c.firstName : "",
        lastName: typeof c.lastName === "string" ? c.lastName : "",
      });
    }
  }

  const tags: string[] = [];
  if (Array.isArray(value.tags)) {
    for (const t of value.tags as unknown[]) {
      if (typeof t === "string" && t.trim()) {
        tags.push(t.trim());
      }
    }
  }

  const reason =
    typeof value.reason === "string" ? value.reason.trim() : "";

  return {
    creators,
    fields,
    itemType: value.itemType.trim(),
    reason,
    tags,
  };
}

const COMMON_FIELD_ALIASES: Record<string, string> = {
  abstract: "abstractNote",
  abstractnote: "abstractNote",
  date: "date",
  doi: "DOI",
  isbn: "ISBN",
  issn: "ISSN",
  issue: "issue",
  issuenumber: "issue",
  issueno: "issue",
  journal: "publicationTitle",
  journaltitle: "publicationTitle",
  language: "language",
  magazine: "publicationTitle",
  page: "pages",
  pages: "pages",
  pagination: "pages",
  publicationdate: "date",
  publishdate: "date",
  shorttitle: "shortTitle",
  title: "title",
  url: "url",
  vol: "volume",
  volume: "volume",
  // Chinese aliases
  "标题": "title",
  "题名": "title",
  "日期": "date",
  "出版日期": "date",
  "发表日期": "date",
  "摘要": "abstractNote",
  "机构": "institution",
  "机构组织": "institution",
  "组织机构": "institution",
  "出版者": "publisher",
  "出版社": "publisher",
  "大学": "university",
  "学校": "university",
  "期刊": "publicationTitle",
  "刊名": "publicationTitle",
  "期刊名称": "publicationTitle",
  "卷": "volume",
  "卷号": "volume",
  "期": "issue",
  "期号": "issue",
  "页码": "pages",
  "页": "pages",
  "起止页码": "pages",
  "语言": "language",
  "网址": "url",
  "链接": "url",
  "报告类型": "reportType",
  "报告编号": "reportNumber",
  "报告号": "reportNumber",
  "系列标题": "seriesTitle",
  "系列名称": "seriesTitle",
  "系列编号": "seriesNumber",
  "系列号": "seriesNumber",
  "丛书编号": "seriesNumber",
};

export function resolveCanonicalFieldName(
  rawKey: string,
  itemType: string,
  validFieldNames: Set<string>,
): string | undefined {
  const trimmed = rawKey.trim();
  if (!trimmed) return undefined;

  // 1. Direct exact match
  if (validFieldNames.has(trimmed)) {
    return trimmed;
  }

  // 2. Normalized alphanumeric lowercase match against valid fields
  const cleanKey = trimmed.toLowerCase().replace(/[\s_\-]+/g, "");
  for (const valid of validFieldNames) {
    if (valid.toLowerCase().replace(/[\s_\-]+/g, "") === cleanKey) {
      return valid;
    }
  }

  // 3. Item-type specific rules
  if (itemType === "report") {
    if (
      cleanKey === "series" ||
      cleanKey === "seriestitle" ||
      cleanKey === "seriesname" ||
      trimmed === "系列" ||
      trimmed === "系列标题" ||
      trimmed === "系列名称"
    ) {
      if (validFieldNames.has("seriesTitle")) return "seriesTitle";
    }
    if (
      cleanKey === "seriesnumber" ||
      cleanKey === "seriesno" ||
      cleanKey === "seriesnum" ||
      trimmed === "系列编号" ||
      trimmed === "系列号" ||
      trimmed === "丛书编号"
    ) {
      if (validFieldNames.has("seriesNumber")) return "seriesNumber";
    }
    if (
      cleanKey === "reportnumber" ||
      cleanKey === "reportno" ||
      cleanKey === "reportnum" ||
      trimmed === "报告编号" ||
      trimmed === "报告号"
    ) {
      if (validFieldNames.has("reportNumber")) return "reportNumber";
    }
    if (cleanKey === "number" || trimmed === "编号") {
      if (validFieldNames.has("reportNumber")) return "reportNumber";
    }
    if (
      cleanKey === "institution" ||
      cleanKey === "organization" ||
      cleanKey === "org" ||
      cleanKey === "authororg" ||
      cleanKey === "publisher" ||
      trimmed === "机构" ||
      trimmed === "机构组织" ||
      trimmed === "组织机构"
    ) {
      if (validFieldNames.has("institution")) return "institution";
    }
    if (
      cleanKey === "reporttype" ||
      cleanKey === "type" ||
      trimmed === "报告类型"
    ) {
      if (validFieldNames.has("reportType")) return "reportType";
    }
  } else {
    // For other types
    if (
      cleanKey === "series" ||
      cleanKey === "seriestitle" ||
      cleanKey === "seriesname" ||
      trimmed === "系列" ||
      trimmed === "系列标题"
    ) {
      if (validFieldNames.has("series")) return "series";
      if (validFieldNames.has("seriesTitle")) return "seriesTitle";
    }
    if (
      cleanKey === "seriesnumber" ||
      cleanKey === "seriesno" ||
      cleanKey === "seriesnum" ||
      trimmed === "系列编号"
    ) {
      if (validFieldNames.has("seriesNumber")) return "seriesNumber";
    }
  }

  // 4. CSL variable mappings (useful when LLM adopts CSL conventions)
  if (cleanKey === "collectiontitle") {
    if (validFieldNames.has("seriesTitle")) return "seriesTitle";
    if (validFieldNames.has("series")) return "series";
  }
  if (cleanKey === "collectionnumber") {
    if (validFieldNames.has("seriesNumber")) return "seriesNumber";
  }

  // 5. Common aliases lookup
  const mapped =
    COMMON_FIELD_ALIASES[cleanKey] || COMMON_FIELD_ALIASES[trimmed];
  if (mapped && validFieldNames.has(mapped)) {
    return mapped;
  }

  return undefined;
}

export function promoteExtraFields(
  itemType: string,
  fields: Record<string, string>,
  validFieldNames: Set<string>,
): Record<string, string> {
  const extra = fields.extra;
  if (!extra || typeof extra !== "string") {
    return fields;
  }

  const lines = extra.split(/\r?\n/);
  const remainingLines: string[] = [];
  const updatedFields: Record<string, string> = { ...fields };

  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9_\-\u4e00-\u9fa5\s]+)[:：]\s*(.+)$/);
    if (!match) {
      remainingLines.push(line);
      continue;
    }

    const [, rawKey, rawVal] = match;
    const value = rawVal.trim();
    const canonicalKey = resolveCanonicalFieldName(
      rawKey,
      itemType,
      validFieldNames,
    );

    if (canonicalKey && canonicalKey !== "extra" && value) {
      // If the target field doesn't already have a value, promote it
      if (!updatedFields[canonicalKey]) {
        updatedFields[canonicalKey] = value;
        try {
          Zotero.debug(
            `Parent Item Generator: promoted extra "${rawKey}: ${value}" to field "${canonicalKey}"`,
          );
        } catch {
          // Ignore debug logger issues in test environments
        }
      }
      // Successfully recognized and handled, don't keep in extra
    } else {
      remainingLines.push(line);
    }
  }

  const newExtra = remainingLines.join("\n").trim();
  if (newExtra) {
    updatedFields.extra = newExtra;
  } else {
    delete updatedFields.extra;
  }

  return updatedFields;
}

export function normalizeAndFilterFields(
  itemType: string,
  rawFields: Record<string, string>,
  validFieldNames: Set<string>,
): Record<string, string> {
  // First, extract and promote any recognized fields from extra
  const fieldsWithPromotedExtra = promoteExtraFields(
    itemType,
    rawFields,
    validFieldNames,
  );

  const filteredFields: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(fieldsWithPromotedExtra)) {
    const value =
      typeof rawValue === "string"
        ? rawValue.trim()
        : String(rawValue ?? "").trim();
    if (!value) continue;

    if (rawKey === "extra") {
      filteredFields.extra = value;
      continue;
    }

    const canonicalKey = resolveCanonicalFieldName(
      rawKey,
      itemType,
      validFieldNames,
    );
    if (canonicalKey) {
      if (!filteredFields[canonicalKey]) {
        filteredFields[canonicalKey] = value;
      }
    } else {
      try {
        Zotero.debug(
          `Parent Item Generator: field "${rawKey}" is not valid for type "${itemType}", ignoring`,
        );
      } catch {
        // Ignore debug logger issues in test environments
      }
    }
  }

  return filteredFields;
}

function validateAndFilterFields(metadata: ParsedMetadata): ParsedMetadata {
  const typeName = metadata.itemType;
  const typeID = Zotero.ItemTypes.getID(typeName) as number | undefined | null;
  if (!typeID) {
    throw new Error(
      `AI returned unknown Zotero item type: "${typeName}". Check your prompt or forced item type setting.`,
    );
  }

  const validFieldNames = new Set<string>(["extra", "title"]);
  try {
    for (const fid of Zotero.ItemFields.getItemTypeFields(typeID) as number[]) {
      const name = Zotero.ItemFields.getName(fid) as string | undefined;
      if (name) {
        validFieldNames.add(name);
      }
    }
  } catch (err) {
    Zotero.logError(err);
  }

  const filteredFields = normalizeAndFilterFields(
    typeName,
    metadata.fields,
    validFieldNames,
  );

  const validCreatorTypes = new Set<string>();
  try {
    const ctypes = Zotero.CreatorTypes.getTypesForItemType(typeID) as Array<{
      id: number;
      name: string;
    }>;
    for (const ct of ctypes) {
      validCreatorTypes.add(ct.name);
    }
  } catch (err) {
    Zotero.logError(err);
    validCreatorTypes.add("author");
  }

  const filteredCreators = metadata.creators.filter((c) => {
    if (validCreatorTypes.has(c.creatorType)) {
      return true;
    }
    Zotero.debug(
      `Parent Item Generator: creator type "${c.creatorType}" not valid for type "${typeName}", ignoring`,
    );
    return false;
  });

  return {
    ...metadata,
    creators: filteredCreators,
    fields: filteredFields,
  };
}

async function createParentItem(
  pdfItem: ZoteroItem,
  metadata: ParsedMetadata,
): Promise<ZoteroItem> {
  if (!metadata.itemType) {
    throw new Error("AI did not return a valid item type.");
  }

  const newItem = new Zotero.Item(metadata.itemType);
  newItem.libraryID = pdfItem.libraryID;

  for (const [key, value] of Object.entries(metadata.fields)) {
    if (value && key !== "extra") {
      try {
        newItem.setField(key, value);
      } catch (err) {
        Zotero.debug(
          `Parent Item Generator: setField("${key}") failed: ${String(err)}`,
        );
      }
    }
  }

  const validCreators = metadata.creators.filter(
    (c) => c.lastName || c.firstName,
  );
  if (validCreators.length > 0) {
    newItem.setCreators(validCreators);
  }

  for (const collectionID of pdfItem.getCollections?.() ?? []) {
    newItem.addToCollection(collectionID);
  }
  addInheritedTags(newItem, pdfItem);
  addTagIfMissing(newItem, "itemByAI");
  for (const tag of metadata.tags) {
    addTagIfMissing(newItem, tag);
  }

  const extraParts: string[] = [];
  if (metadata.fields.extra?.trim()) {
    extraParts.push(metadata.fields.extra.trim());
  }
  if (metadata.reason?.trim()) {
    extraParts.push(`AI Reason: ${metadata.reason.trim()}`);
  }
  if (extraParts.length > 0) {
    try {
      newItem.setField("extra", extraParts.join("\n"));
    } catch {
      // extra field may not exist for some item types
    }
  }

  const parentID = await newItem.saveTx();
  if (typeof parentID !== "number" || parentID <= 0) {
    throw new Error("Zotero did not return a valid parent item ID.");
  }

  pdfItem.parentItemID = parentID;
  await pdfItem.saveTx();

  return newItem;
}

function addInheritedTags(newItem: ZoteroItem, pdfItem: ZoteroItem): void {
  const seen = new Set<string>();
  for (const rawTag of pdfItem.getTags?.() ?? []) {
    const tag = normalizeTag(rawTag);
    if (!tag || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    addTagIfMissing(newItem, tag);
  }
}

function addTagIfMissing(item: ZoteroItem, tag: string): void {
  const normalizedTag = tag.trim();
  if (!normalizedTag) {
    return;
  }

  const existing = new Set<string>();
  for (const rawTag of item.getTags?.() ?? []) {
    const tagName = normalizeTag(rawTag);
    if (tagName) {
      existing.add(tagName);
    }
  }

  if (!existing.has(normalizedTag)) {
    item.addTag(normalizedTag);
  }
}

function normalizeTag(rawTag: unknown): string {
  if (typeof rawTag === "string") {
    return rawTag.trim();
  }
  if (isRecord(rawTag) && typeof rawTag.tag === "string") {
    return rawTag.tag.trim();
  }
  return "";
}

function parseObjectJSON(text: string, label: string): Record<string, any> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return parsed;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateForPrompt(text: string): string {
  if (text.length <= MAX_PAGE_TEXT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_PAGE_TEXT_CHARS)}...`;
}

function truncateForLog(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= 500) {
    return normalized;
  }
  return `${normalized.slice(0, 500)}...`;
}

function getAttachmentFilename(pdfItem: ZoteroItem, filePath: string): string {
  if (typeof pdfItem.attachmentFilename === "string") {
    return pdfItem.attachmentFilename;
  }

  return filePath.replace(/\\/g, "/").split("/").pop() || "attachment.pdf";
}

function getAttachmentTitle(pdfItem: ZoteroItem): string {
  const title = pdfItem.getField?.("title");
  return typeof title === "string" ? title.trim() : "";
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOwn(value: Record<string, any>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

