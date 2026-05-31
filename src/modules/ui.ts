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

export function previewMetadata(
  metadata: ParsedMetadata,
  round: number,
): MetadataPreviewAction {
  const win = Zotero.getMainWindow?.() ?? null;
  const buttonFlags =
    Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_0 +
    Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_1 +
    Services.prompt.BUTTON_TITLE_CANCEL * Services.prompt.BUTTON_POS_2;
  const buttonIndex = Services.prompt.confirmEx(
    win,
    addon.data.config.addonName,
    buildPreviewText(metadata, round),
    buttonFlags,
    "Accept",
    "Improve",
    "",
    "",
    {},
  );

  if (buttonIndex === 0) {
    return "accept";
  }
  if (buttonIndex === 1) {
    return "improve";
  }
  return "cancel";
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

function buildPreviewText(metadata: ParsedMetadata, round: number): string {
  const lines: string[] = [
    `AI extracted metadata (round ${round}):`,
    "",
    `Item Type: ${metadata.itemType || "(empty)"}`,
  ];

  for (const [key, value] of Object.entries(metadata.fields)) {
    if (value) {
      lines.push(`${key}: ${value}`);
    }
  }

  if (metadata.creators.length > 0) {
    const authorStr = metadata.creators
      .map((c) =>
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
    "Cancel: discard",
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

export function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
