import {
  createParentItemFromMetadata,
  extractMetadataDraftFromPDF,
  generateParentItemFromPDF,
  improveMetadataDraft,
  isStandalonePDFAttachment,
  type MetadataDraft,
} from "./metadataExtractor";
import {
  alertUser,
  BatchRunStatus,
  confirmContinueBatch,
  previewMetadata,
  promptImprovementFeedback,
  RunStatus,
  stringifyError,
} from "./ui";

type MenuContext = {
  items?: ZoteroItem[];
  setEnabled?: (enabled: boolean) => void;
};

const MENU_ID = "generate-parent-item";

export function registerGenerateParentMenu(): void {
  if (addon.data.menuRegistrationID) {
    return;
  }

  const registeredID = Zotero.MenuManager.registerMenu({
    menuID: `${addon.data.config.addonRef}-${MENU_ID}`,
    pluginID: addon.data.config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: `${addon.data.config.addonRef}-generate-parent-item`,
        onShowing: (_event: Event, context: MenuContext) => {
          context.setEnabled?.(getEligibleItems(context).length > 0);
        },
        onCommand: (_event: Event, context: MenuContext) => {
          void handleMenuCommand(context);
        },
      },
    ],
  });

  if (!registeredID) {
    Zotero.logError(
      new Error("Parent Item Generator failed to register MenuManager item"),
    );
    return;
  }

  addon.data.menuRegistrationID = registeredID;
}

export function unregisterGenerateParentMenu(): void {
  const registrationID = addon.data.menuRegistrationID;
  if (!registrationID) {
    return;
  }

  Zotero.MenuManager.unregisterMenu(registrationID);
  delete addon.data.menuRegistrationID;
}

function getEligibleItems(context: MenuContext): ZoteroItem[] {
  const items = getContextItems(context);
  const eligible = items.filter(isStandalonePDFAttachment);
  Zotero.debug(
    `Parent Item Generator: menu items check selected=${items.length}, eligible=${eligible.length}`,
  );
  return eligible;
}

function getContextItems(context: MenuContext): ZoteroItem[] {
  if (Array.isArray(context.items)) {
    return context.items;
  }

  const pane = Zotero.getActiveZoteroPane?.();
  return pane?.getSelectedItems?.() ?? [];
}

async function handleMenuCommand(context: MenuContext): Promise<void> {
  const items = getEligibleItems(context);
  if (items.length === 0) {
    return;
  }

  if (items.length === 1) {
    await handleSingleItem(items[0]);
  } else {
    await handleBatchItems(items);
  }
}

async function handleSingleItem(item: ZoteroItem): Promise<void> {
  if (addon.data.busyItemIDs.has(item.id)) {
    return;
  }

  addon.data.busyItemIDs.add(item.id);
  try {
    let draft = await extractDraftWithStatus(item);
    let round = 1;
    while (true) {
      const { action } = previewMetadata(draft.metadata, round);
      if (action === "cancel") {
        return;
      }

      if (action === "accept") {
        break;
      }

      const feedback = promptImprovementFeedback();
      if (!feedback) {
        continue;
      }
      draft = await improveDraftWithStatus(item, draft, feedback);
      round += 1;
    }

    await createItemWithStatus(item, draft);
  } catch (error) {
    Zotero.logError(error);
    await alertUser(stringifyError(error), "Metadata extraction failed");
  } finally {
    addon.data.busyItemIDs.delete(item.id);
  }
}

async function handleBatchItems(items: ZoteroItem[]): Promise<void> {
  const availableItems = items.filter(
    (item) => !addon.data.busyItemIDs.has(item.id),
  );
  if (availableItems.length === 0) {
    return;
  }

  for (const item of availableItems) {
    addon.data.busyItemIDs.add(item.id);
  }

  const status = new BatchRunStatus(availableItems.length);
  const failures: Array<{ item: ZoteroItem; error: unknown }> = [];
  let successCount = 0;
  let skippedCount = 0;
  let autoAcceptRemaining = false;

  try {
    for (let i = 0; i < availableItems.length; i++) {
      if (!addon.data.alive) {
        break;
      }

      const item = availableItems[i];
      const itemIndex = i + 1;
      const total = availableItems.length;
      const title = getItemDisplayName(item);

      status.updateItem(itemIndex, total, title, "Extracting metadata", 0);

      try {
        let draft = await extractMetadataDraftFromPDF(item, (progress) => {
          status.updateItem(
            itemIndex,
            total,
            title,
            progress.message,
            progress.percent,
          );
        });

        let round = 1;
        let shouldCreate = true;

        if (!autoAcceptRemaining) {
          while (true) {
            status.updateItem(
              itemIndex,
              total,
              title,
              "Waiting for confirmation",
              100,
            );

            const previewRes = previewMetadata(draft.metadata, round, {
              currentIndex: itemIndex,
              itemTitle: title,
              total,
            });

            if (previewRes.action === "cancel") {
              shouldCreate = false;
              skippedCount += 1;
              if (i < availableItems.length - 1) {
                const continueBatch = confirmContinueBatch(total - itemIndex);
                if (!continueBatch) {
                  return;
                }
              }
              break;
            }

            if (previewRes.action === "accept") {
              if (previewRes.applyToAll) {
                autoAcceptRemaining = true;
              }
              break;
            }

            const feedback = promptImprovementFeedback();
            if (!feedback) {
              continue;
            }

            status.updateItem(
              itemIndex,
              total,
              title,
              "Improving metadata",
              50,
            );
            draft = await improveMetadataDraft(
              item,
              draft,
              feedback,
              (progress) => {
                status.updateItem(
                  itemIndex,
                  total,
                  title,
                  progress.message,
                  progress.percent,
                );
              },
            );
            round += 1;
          }
        }

        if (shouldCreate) {
          status.updateItem(
            itemIndex,
            total,
            title,
            "Creating parent item",
            90,
          );
          await createParentItemFromMetadata(item, draft.metadata);
          successCount += 1;
        }
      } catch (error) {
        Zotero.logError(error);
        failures.push({ item, error });
      } finally {
        addon.data.busyItemIDs.delete(item.id);
      }
    }

    status.finish(successCount, failures.length, skippedCount);

    if (failures.length > 0) {
      const summary = failures
        .map(
          (f) => `• ${getItemDisplayName(f.item)}: ${stringifyError(f.error)}`,
        )
        .join("\n");
      await alertUser(
        `Batch generation completed with ${failures.length} failure(s):\n\n${summary}`,
        "Batch Generation Summary",
      );
    }
  } finally {
    for (const item of availableItems) {
      addon.data.busyItemIDs.delete(item.id);
    }
  }
}

function getItemDisplayName(item: ZoteroItem): string {
  try {
    const title = item.getField?.("title");
    if (typeof title === "string" && title.trim()) {
      return title.trim();
    }
    if (
      typeof item.attachmentFilename === "string" &&
      item.attachmentFilename.trim()
    ) {
      return item.attachmentFilename.trim();
    }
  } catch {
    // Ignore error reading title/filename
  }
  return `Item #${item.id}`;
}

async function extractDraftWithStatus(
  item: ZoteroItem,
): Promise<MetadataDraft> {
  const status = new RunStatus("Preparing metadata extraction");
  try {
    const draft = await extractMetadataDraftFromPDF(item, (progress) => {
      status.update(progress.message, progress.percent);
    });
    status.complete("Metadata extracted. Please review the preview.");
    return draft;
  } catch (error) {
    status.fail("Metadata extraction failed");
    throw error;
  }
}

async function improveDraftWithStatus(
  item: ZoteroItem,
  draft: MetadataDraft,
  feedback: string,
): Promise<MetadataDraft> {
  const status = new RunStatus("Improving metadata");
  try {
    const nextDraft = await improveMetadataDraft(
      item,
      draft,
      feedback,
      (progress) => {
        status.update(progress.message, progress.percent);
      },
    );
    status.complete("Metadata improved. Please review again.");
    return nextDraft;
  } catch (error) {
    status.fail("Metadata improvement failed");
    throw error;
  }
}

async function createItemWithStatus(
  item: ZoteroItem,
  draft: MetadataDraft,
): Promise<ZoteroItem> {
  const status = new RunStatus("Creating Zotero parent item");
  try {
    status.update("Creating Zotero parent item", 50);
    const parentItem = await createParentItemFromMetadata(item, draft.metadata);
    status.complete(
      `Created "${parentItem.getField("title") || parentItem.key}" (${draft.metadata.itemType}).`,
    );
    return parentItem;
  } catch (error) {
    status.fail("Failed to create parent item");
    throw error;
  }
}
