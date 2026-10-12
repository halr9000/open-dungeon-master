// Opens the world database once, as a server boot does, for tests that need
// a real restart (a fresh process) rather than a second getDatabase() call.
// Run with SQLITE_DB_PATH and DB_ENCRYPTION_KEY set; prints what the boot
// logged to stdout.
import { register } from "node:module";

register("./register-alias.mjs", import.meta.url);

const { getDatabase } = await import("../../src/lib/db/core.ts");
getDatabase();
