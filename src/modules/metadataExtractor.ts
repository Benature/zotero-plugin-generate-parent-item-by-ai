export type PDFTextSample = {
  attachmentTitle: string;
  filename: string;
  firstPageText: string;
  lastPageText: string;
  pageCount: number;
  pagesExtracted: boolean;
};

type LLMSettings = {
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
  report: title, date, reportType, institution, seriesTitle, seriesNumber
  book: title, date, publisher, place, ISBN, numPages, edition
  thesis: title, date, university, thesisType, numPages
  conferencePaper: title, date, conferenceName, proceedingsTitle, pages, DOI
  preprint: title, date, repository, DOI
  bookSection: title, date, bookTitle, publisher, place, pages
  webpage: title, date, websiteTitle, url, accessDate

Use exact Zotero field names. The "extra" field (always valid) may hold additional metadata.`;

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
          content: buildPrompt(sample, settings, feedback, previousMetadata, filenameOnly),
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
      `LLM request failed (${response.status} ${response.statusText}): ${truncateForLog(
        responseText,
      )}`,
    );
  }

  const responseJSON = parseObjectJSON(responseText, "LLM HTTP response");
  const content = responseJSON.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("LLM response did not contain choices[0].message.content.");
  }

  const parsed = parseMetadataJSON(content);
  return validateAndFilterFields(
    settings.forcedItemType
      ? { ...parsed, itemType: settings.forcedItemType }
      : parsed,
  );
}

function readLLMSettings(): LLMSettings {
  const prefix = addon.data.config.prefsPrefix;
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

function parseMetadataJSON(content: string): ParsedMetadata {
  const trimmed = content.trim();
  if (
    !trimmed.startsWith("{") ||
    !trimmed.endsWith("}") ||
    trimmed.startsWith("```")
  ) {
    throw new Error("LLM returned non-JSON content.");
  }

  const value = parseObjectJSON(trimmed, "LLM metadata JSON");

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

  const filteredFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata.fields)) {
    if (validFieldNames.has(key)) {
      filteredFields[key] = value;
    } else {
      Zotero.debug(
        `Parent Item Generator: field "${key}" is not valid for type "${typeName}", ignoring`,
      );
    }
  }

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
    if (value) {
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

  if (metadata.reason) {
    const existing = (newItem.getField("extra") as string | undefined) ?? "";
    const reasonLine = `AI Reason: ${metadata.reason}`;
    const newExtra = existing ? `${existing}\n${reasonLine}` : reasonLine;
    try {
      newItem.setField("extra", newExtra);
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

