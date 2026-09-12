import type { ParsedMetadata } from "./metadataExtractor";

export async function alertUser(
  message: string,
  title = addon.data.config.addonName,
): Promise<void> {
  const win = Zotero.getMainWindow?.();
  if (win?.alert) {
    win.alert(`${title}\n\n${message}`);
    return;
  }

  Zotero.debug(`${title}: ${message}`);
}

export type MetadataPreviewAction = "accept" | "improve" | "cancel";

type ProgressItem = {
  setProgress(percent: number): void;
  setText(text: string): void;
};

type ProgressWindow = {
  ItemProgress: new (iconSrc: string, text: string) => ProgressItem;
  changeHeadline(text: string): void;
  progress?: ProgressItem;
  show(): boolean;
  startCloseTimer(ms: number): void;
};

export type BatchPreviewContext = {
  currentIndex: number;
  itemTitle: string;
  total: number;
};

export type MetadataPreviewResult = {
  action: MetadataPreviewAction;
  applyToAll?: boolean;
};

export function previewMetadata(
  metadata: ParsedMetadata,
  round: number,
  batchContext?: BatchPreviewContext,
): MetadataPreviewResult {
  const win = Zotero.getMainWindow?.() ?? null;
  const buttonFlags =
    Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_0 +
    Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_1 +
    Services.prompt.BUTTON_TITLE_CANCEL * Services.prompt.BUTTON_POS_2;
  const checkState = { value: false };
  const checkMsg = batchContext
    ? "后续条目全部直接接受，不再提示 (Accept all remaining without prompting)"
    : "";

  const buttonIndex = Services.prompt.confirmEx(
    win,
    addon.data.config.addonName,
    buildPreviewText(metadata, round, batchContext),
    buttonFlags,
    "Accept",
    "Improve",
    "",
    checkMsg,
    checkState,
  );

  if (buttonIndex === 0) {
    return { action: "accept", applyToAll: Boolean(checkState.value) };
  }
  if (buttonIndex === 1) {
    return { action: "improve" };
  }
  return { action: "cancel" };
}

export function confirmContinueBatch(remainingCount: number): boolean {
  const win = Zotero.getMainWindow?.() ?? null;
  return Services.prompt.confirm(
    win,
    addon.data.config.addonName,
    `已跳过当前条目。\n\n是否继续处理剩余的 ${remainingCount} 个条目？\n(Skip this item. Continue processing remaining ${remainingCount} items?)`,
  );
}

export function promptImprovementFeedback(): string | undefined {
  const win = Zotero.getMainWindow?.() ?? null;
  const value = { value: "" };
  const ok = Services.prompt.prompt(
    win,
    addon.data.config.addonName,
    "Describe how you'd like the AI to improve the extracted metadata:",
    value,
    "",
    {},
  );

  if (!ok) {
    return undefined;
  }

  return value.value.trim() || undefined;
}

function buildPreviewText(
  metadata: ParsedMetadata,
  round: number,
  batchContext?: BatchPreviewContext,
): string {
  const lines: string[] = [];

  if (batchContext) {
    lines.push(
      `[${batchContext.currentIndex}/${batchContext.total}] ${batchContext.itemTitle}`,
      "",
    );
  }

  lines.push(
    `AI extracted metadata (round ${round}):`,
    "",
    `Item Type: ${metadata.itemType || "(empty)"}`,
  );

  for (const [key, value] of Object.entries(metadata.fields)) {
    if (value) {
      lines.push(`${key}: ${value}`);
    }
  }

  if (metadata.creators.length > 0) {
    const authorStr = metadata.creators
      .map(
        (c) =>
          [c.firstName, c.lastName].filter(Boolean).join(" ") ||
          `(${c.creatorType})`,
      )
      .join("; ");
    lines.push(`Creators: ${authorStr}`);
  }

  if (metadata.tags.length > 0) {
    lines.push(`Tags: ${metadata.tags.join(", ")}`);
  }

  if (metadata.reason) {
    lines.push(`AI Reason: ${metadata.reason}`);
  }

  lines.push(
    "",
    "Accept: create parent item",
    "Improve: ask AI to revise",
    batchContext ? "Cancel: skip this item" : "Cancel: discard",
  );

  return lines.join("\n");
}

export class RunStatus {
  private progressWindow?: ProgressWindow;
  private itemProgress?: ProgressItem;

  constructor(message: string) {
    try {
      const progressWindow = new Zotero.ProgressWindow({
        closeOnClick: true,
      }) as ProgressWindow;
      progressWindow.changeHeadline(addon.data.config.addonName);
      const itemProgress = new progressWindow.ItemProgress(
        "chrome://zotero/skin/treesource-library.svg",
        message,
      );
      progressWindow.progress = itemProgress;
      this.progressWindow = progressWindow;
      this.itemProgress = itemProgress;
      itemProgress.setProgress(0);
      progressWindow.show();
    } catch (error) {
      Zotero.debug(`${addon.data.config.addonName}: ${message}`);
    }
  }

  update(message: string, percent: number): void {
    if (!this.itemProgress) {
      Zotero.debug(`${addon.data.config.addonName}: ${message}`);
      return;
    }

    this.itemProgress.setText(message);
    this.itemProgress.setProgress(Math.max(0, Math.min(100, percent)));
  }

  complete(message: string): void {
    if (!this.progressWindow || !this.itemProgress) {
      Zotero.debug(`${addon.data.config.addonName}: ${message}`);
      return;
    }

    this.itemProgress.setText(message);
    this.itemProgress.setProgress(100);
    this.progressWindow.startCloseTimer(3500);
  }

  fail(message: string): void {
    if (!this.progressWindow || !this.itemProgress) {
      Zotero.debug(`${addon.data.config.addonName}: ${message}`);
      return;
    }

    this.itemProgress.setText(message);
    this.itemProgress.setProgress(100);
    this.progressWindow.startCloseTimer(7000);
  }
}

export class BatchRunStatus {
  private progressWindow?: ProgressWindow;
  private overallProgress?: ProgressItem;

  constructor(total: number) {
    try {
      const progressWindow = new Zotero.ProgressWindow({
        closeOnClick: true,
      }) as ProgressWindow;
      progressWindow.changeHeadline(
        `${addon.data.config.addonName} (Batch 0/${total})`,
      );
      const overallProgress = new progressWindow.ItemProgress(
        "chrome://zotero/skin/treesource-library.svg",
        `Starting batch for ${total} items...`,
      );
      progressWindow.progress = overallProgress;
      this.progressWindow = progressWindow;
      this.overallProgress = overallProgress;
      overallProgress.setProgress(0);
      progressWindow.show();
    } catch (error) {
      Zotero.debug(`${addon.data.config.addonName}: Batch start ${total}`);
    }
  }

  updateItem(
    currentIndex: number,
    total: number,
    title: string,
    message: string,
    itemPercent: number,
  ): void {
    if (!this.progressWindow || !this.overallProgress) {
      Zotero.debug(
        `${addon.data.config.addonName}: [${currentIndex}/${total}] ${title}: ${message} (${itemPercent}%)`,
      );
      return;
    }

    this.progressWindow.changeHeadline(
      `${addon.data.config.addonName} (${currentIndex}/${total})`,
    );

    const safePercent = Math.max(0, Math.min(100, itemPercent));
    const overallPercent = Math.round(
      ((currentIndex - 1 + safePercent / 100) / total) * 100,
    );

    this.overallProgress.setText(
      `[${currentIndex}/${total}] ${title}: ${message}`,
    );
    this.overallProgress.setProgress(overallPercent);
  }

  finish(successCount: number, failCount: number, skippedCount = 0): void {
    const total = successCount + failCount + skippedCount;
    if (!this.progressWindow || !this.overallProgress) {
      Zotero.debug(
        `${addon.data.config.addonName}: Batch finished: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped.`,
      );
      return;
    }

    this.overallProgress.setProgress(100);

    const parts: string[] = [];
    if (successCount > 0) parts.push(`${successCount} created`);
    if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
    if (failCount > 0) parts.push(`${failCount} failed`);
    const summaryText = parts.join(", ") || "0 processed";

    if (failCount === 0 && skippedCount === 0) {
      this.progressWindow.changeHeadline(
        `${addon.data.config.addonName} (Complete)`,
      );
      this.overallProgress.setText(
        `Batch complete: ${successCount} parent item(s) created.`,
      );
      this.progressWindow.startCloseTimer(4000);
    } else if (successCount === 0) {
      this.progressWindow.changeHeadline(
        `${addon.data.config.addonName} (Failed)`,
      );
      this.overallProgress.setText(`Batch finished: ${summaryText}.`);
      this.progressWindow.startCloseTimer(8000);
    } else {
      this.progressWindow.changeHeadline(
        `${addon.data.config.addonName} (Completed with warnings)`,
      );
      this.overallProgress.setText(`Batch complete: ${summaryText}.`);
      this.progressWindow.startCloseTimer(6000);
    }
  }
}

export function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
