import { config } from "../package.json";
import hooks from "./hooks";

class Addon {
  public data: {
    alive: boolean;
    busyItemIDs: Set<number>;
    config: typeof config;
    env: "development" | "production";
    initialized: boolean;
    menuRegistrationID?: string;
    prefsPaneID?: string;
  };

  public hooks: typeof hooks;

  public api: object;

  constructor() {
    this.data = {
      alive: true,
      busyItemIDs: new Set<number>(),
      config,
      env: __env__,
      initialized: false,
    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
