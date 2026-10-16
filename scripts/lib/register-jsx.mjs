// The loader for server-rendered UI regressions. It was the alias loader
// plus a .tsx compile; the compile now lives in register-alias.mjs, which
// every suite already uses, and this name is kept for the suites that
// register it.
export { load, resolve } from "./register-alias.mjs";
