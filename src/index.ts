import { config } from "../package.json";
import Addon from "./addon";

if (!_globalThis.Zotero[config.addonInstance]) {
  _globalThis.addon = new Addon();
  _globalThis.Zotero[config.addonInstance] = _globalThis.addon;
}
