declare const _globalThis: {
  [key: string]: any;
  Zotero: any;
  addon: import("../src/addon").default;
};

declare const addon: import("../src/addon").default;
declare const __env__: "production" | "development";
declare const ChromeUtils: any;
declare const IOUtils: {
  read(path: string): Promise<Uint8Array>;
};
declare const PathUtils: any;
declare const Services: any;
declare const Zotero: any;

type ZoteroItem = any;

interface Window {
  MozXULElement?: {
    insertFTLIfNeeded?: (path: string) => void;
  };
}
