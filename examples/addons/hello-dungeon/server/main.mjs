// Hello Dungeon: the example addon. Each tool below is named by a
// contribution in addon.json, and receives the arguments the server's
// contract for that extension point describes (docs/addons/extension-points.md).

import { createServer } from "./mcp.mjs";
import { generateCavern } from "./cavern.mjs";
import { runSetup } from "./setup.mjs";
import { importStatblocks } from "./statblocks.mjs";

// The admin's settings for this addon, as JSON, read once at start. The
// server restarts the addon when they change.
const settings = JSON.parse(process.env.ODM_ADDON_SETTINGS || "{}");

const server = createServer({ name: "hello-dungeon", version: process.env.ODM_ADDON_VERSION || "dev" });

server.tool(
  "import_statblocks",
  "Read a text file of '# Monster:' and '# Lore:' sections into a workshop bundle.",
  {
    type: "object",
    properties: {
      input: { type: "object" },
      outputDir: { type: "string" },
      options: { type: "object" },
      host: { type: "object" },
    },
    required: ["input", "outputDir"],
  },
  importStatblocks,
);

server.tool(
  "generate_cavern",
  "Grow a cavern battle map from a seed, with a picture and a 3D model of its walls.",
  {
    type: "object",
    properties: {
      request: { type: "object" },
      outputDir: { type: "string" },
      options: { type: "object" },
      host: { type: "object" },
    },
    required: ["request", "outputDir"],
  },
  (args, ctx) => generateCavern(args, ctx, settings),
);

server.tool(
  "odm_setup",
  "Prepare the addon after it is installed or updated: paint the texture the board view loads.",
  {
    type: "object",
    properties: {
      dataDir: { type: "string" },
      publicDir: { type: "string" },
      packageDir: { type: "string" },
      host: { type: "object" },
    },
    required: ["publicDir"],
  },
  (args, ctx) => runSetup(args, ctx, settings),
);

server.listen();
console.error(`[hello-dungeon] ready (data folder ${process.env.ODM_ADDON_DATA_DIR})`);
