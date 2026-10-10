import { describe, expect, it } from "vitest";
import { filterModels, sortModels, type PickerModel } from "@/components/FilterableModelPicker";

// The model picker's pure side: which rows a query leaves, and the order
// they stand in. Everything else about the picker is DOM.

const MODEL = (id: string, label = id, created?: number): PickerModel => ({ id, label, ...(created !== undefined ? { created } : {}) });

describe("sortModels", () => {
  it("puts the newest first and the undated last", () => {
    const models = [MODEL("old", "Old", 1_000), MODEL("never"), MODEL("new", "New", 2_000), MODEL("also-never")];
    // Undated ties break by id for a stable order.
    expect(sortModels(models, "newest").map((model) => model.id)).toEqual(["new", "old", "also-never", "never"]);
  });

  it("keeps the server's own order when sorted that way, undated included", () => {
    const models = [MODEL("b"), MODEL("a"), MODEL("c")];
    expect(sortModels(models, "server").map((model) => model.id)).toEqual(["b", "a", "c"]);
  });

  it("breaks date ties by id, so the order is stable", () => {
    const models = [MODEL("zeta", "Z", 100), MODEL("alpha", "A", 100), MODEL("mid", "M", 200)];
    expect(sortModels(models, "newest").map((model) => model.id)).toEqual(["mid", "alpha", "zeta"]);
  });

  it("leaves an empty list empty", () => {
    expect(sortModels([], "newest")).toEqual([]);
  });
});

describe("filterModels", () => {
  const models = [
    MODEL("openai/gpt-5.1", "GPT-5.1"),
    MODEL("google/gemini-3.5-flash", "Gemini 3.5 Flash", 1_700_000_000),
    MODEL("qwen/qwen3.6-35b", "Qwen3.6 35B", 1_800_000_000),
  ];

  it("matches the id case-insensitively", () => {
    expect(filterModels(models, "GEMINI", "server").map((model) => model.id)).toEqual(["google/gemini-3.5-flash"]);
  });

  it("matches the display name too", () => {
    expect(filterModels(models, "flash", "server").map((model) => model.id)).toEqual(["google/gemini-3.5-flash"]);
  });

  it("trims the query; a blank query is every model", () => {
    expect(filterModels(models, "  ", "server").length).toBe(3);
    expect(filterModels(models, " qwen ", "server").map((model) => model.id)).toEqual(["qwen/qwen3.6-35b"]);
  });

  it("sorts newest first while filtering, undated last", () => {
    expect(filterModels(models, "", "newest").map((model) => model.id)).toEqual([
      "qwen/qwen3.6-35b",
      "google/gemini-3.5-flash",
      "openai/gpt-5.1",
    ]);
  });

  it("answers nothing for a query nothing matches", () => {
    expect(filterModels(models, "llama", "server")).toEqual([]);
  });
});
