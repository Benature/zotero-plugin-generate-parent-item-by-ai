import {
  createParentItemFromMetadata,
  extractMetadataDraftFromPDF,
  improveMetadataDraft,
  isStandalonePDFAttachment,
  type MetadataDraft,
} from "./metadataExtractor";
import {
  alertUser,
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
          context.setEnabled?.(Boolean(getEligibleItem(context)));
        },
        onCommand: (_event: Event, context: MenuContext) => {
          void handleMenuCommand(context);
        },
      },
    ],
  });

  if (!registeredID) {
    Zotero.logError(
      new Error(
        "Parent Item Generator failed to register MenuManager item",
      ),
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

function getEligibleItem(context: MenuContext): ZoteroItem | undefined {
  const items = getContextItems(context);
  if (items.length !== 1) {
    Zotero.debug(
      `Parent Item Generator: menu disabled, selected item count=${items.length}`,
    );
    return undefined;
  }

  const item = items[0];
  const eligible = isStandalonePDFAttachment(item);
  Zotero.debug(
    `Parent Item Generator: menu item check id=${item.id}, attachment=${Boolean(
      item.isAttachment?.(),
    )}, pdf=${Boolean(
      item.isPDF?.() ||
        item.isPDFAttachment?.() ||
        item.attachmentContentType === "application/pdf",
    )}, parentID=${item.parentID ?? item.parentItemID ?? ""}, eligible=${eligible}`,
  );

  return eligible ? item : undefined;
}

function getContextItems(context: MenuContext): ZoteroItem[] {
  if (Array.isArray(context.items)) {
    return context.items;
  }

  const pane = Zotero.getActiveZoteroPane?.();
  return pane?.getSelectedItems?.() ?? [];
}

async function handleMenuCommand(context: MenuContext): Promise<void> {
  const item = getEligibleItem(context);
  if (!item) {
    return;
  }

  if (addon.data.busyItemIDs.has(item.id)) {
    return;
  }

  addon.data.busyItemIDs.add(item.id);
  try {
    let draft = await extractDraftWithStatus(item);
    let round = 1;
    while (true) {
      const action = previewMetadata(draft.metadata, round);
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

async function extractDraftWithStatus(item: ZoteroItem): Promise<MetadataDraft> {
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
    const nextDraft = await improveMetadataDraft(item, draft, feedback, (progress) => {
      status.update(progress.message, progress.percent);
    });
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
