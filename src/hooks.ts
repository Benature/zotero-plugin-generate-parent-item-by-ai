import {
  registerGenerateParentMenu,
  unregisterGenerateParentMenu,
} from "./modules/menu";
import { registerPreferencesAPI } from "./modules/preferences";

async function onStartup(): Promise<void> {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  await Promise.all(
    Zotero.getMainWindows().map((win: Window) => onMainWindowLoad(win)),
  );

  registerGenerateParentMenu();
  registerPreferencesAPI();
  registerPreferencesPane();

  addon.data.initialized = true;
}

function registerPreferencesPane(): void {
  const chromeBase = `chrome://${addon.data.config.addonRef}/content`;
  const paneID = Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: `${chromeBase}/preferences.xhtml`,
    label: addon.data.config.addonName,
    scripts: [`${chromeBase}/preferences.js`],
  });
  if (paneID) {
    addon.data.prefsPaneID = paneID;
  }
}

async function onMainWindowLoad(win: Window): Promise<void> {
  win.MozXULElement?.insertFTLIfNeeded?.(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
}

async function onMainWindowUnload(win: Window): Promise<void> {}

function onShutdown(): void {
  unregisterGenerateParentMenu();
  if (addon.data.prefsPaneID) {
    Zotero.PreferencePanes.unregister(addon.data.prefsPaneID);
    delete addon.data.prefsPaneID;
  }
  addon.data.alive = false;
  delete Zotero[addon.data.config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
