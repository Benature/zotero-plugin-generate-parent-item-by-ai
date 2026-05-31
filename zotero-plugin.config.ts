import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",
  server: {
    devtools: true,
    prebuild: true,
    asProxy: false,
    createProfileIfMissing: true,
  },
  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        bundle: true,
        define: {
          __env__: `"${process.env.NODE_ENV ?? "production"}"`,
        },
        entryPoints: ["src/index.ts"],
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
        target: "firefox140",
      },
    ],
  },
  release: {
    bumpp: {
      execute: "npm run build:xpi",
    },
    github: {
      repository: "{{owner}}/{{repo}}",
      updater: "release",
    },
  },
  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },
});
