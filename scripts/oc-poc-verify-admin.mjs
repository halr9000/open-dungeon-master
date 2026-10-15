// Sanity: read the sw5epoc hash back and verify it with ODM's own verifyPassword.
import Database from "better-sqlite3-multiple-ciphers";
import { readFileSync } from "node:fs";
import { scryptSync, timingSafeEqual } from "node:crypto";
import { serverEnv } from "../src/lib/server-env.ts";

const dbPath =
  process.env.SQLITE_DB_PATH || serverEnv("SQLITE_DB_PATH") ||
  "/home/halr9000/projects/odm-sw5e/data/sw5e-app.sqlite";
const lines = readFileSync("/home/halr9000/projects/odm-sw5e/.admin-creds", "utf8").trim().split("\n");
const password = lines[1];

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma("cipher='chacha20'");
db.pragma(`key='${serverEnv("DB_ENCRYPTION_KEY").replaceAll("'", "''")}'`);
const row = db.prepare("SELECT password_hash FROM users WHERE username = ?").get("sw5epoc");
const [salt, hash] = row.password_hash.split("$");
const computed = scryptSync(password, Buffer.from(salt, "hex"), 64);
const ok = computed.length === hash.length / 2 &&
  timingSafeEqual(computed, Buffer.from(hash, "hex"));
console.log("verify with file creds:", ok);
console.log("hash prefix:", row.password_hash.slice(0, 16));
db.close();
