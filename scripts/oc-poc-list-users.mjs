// Read users table from the SW5e POC app DB (read-only).
import Database from "better-sqlite3-multiple-ciphers";
import { serverEnv } from "../src/lib/server-env.ts";

const dbPath =
  process.env.SQLITE_DB_PATH || serverEnv("SQLITE_DB_PATH") ||
  "/home/halr9000/projects/odm-sw5e/data/sw5e-app.sqlite";
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma("cipher='chacha20'");
db.pragma(`key='${serverEnv("DB_ENCRYPTION_KEY").replaceAll("'", "''")}'`);
const users = db.prepare("SELECT username, is_admin FROM users").all();
console.log(JSON.stringify(users));
db.close();
