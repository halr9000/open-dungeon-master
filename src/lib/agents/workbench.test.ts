import { describe, expect, it } from "vitest";

import { WORKBENCH_TOOLS } from "@/lib/agents/workbench";

const write = WORKBENCH_TOOLS.find((tool) => tool.name === "odm_write_lore");
const facts = WORKBENCH_TOOLS.find((tool) => tool.name === "odm_get_facts");
const CAMP = "aaec4519-8252-4da8-8bab-d84ae8a00685";
const ENTRY = "654809c0-24b7-4c54-92ca-73e67cc7ef80";

function methodOf(tool: NonNullable<typeof write>, args: Record<string, unknown>) {
  return typeof tool.method === "function" ? tool.method(args) : tool.method;
}

describe("odm_write_lore", () => {
  it("is registered on the campaigns scope", () => {
    expect(write?.scope).toBe("campaigns");
  });

  it("routes create to POST /lore without an id segment", () => {
    const args = { campaignId: CAMP, action: "create", category: "history", title: "T", body: "B" };
    expect(methodOf(write!, args)).toBe("POST");
    expect(write!.path(args)).toBe(`/api/campaigns/${CAMP}/lore`);
    expect(write!.body!(args)).toEqual({ category: "history", title: "T", body: "B" });
    expect(write!.check!(args)).toBeNull();
  });

  it("create refuses a missing category, title or body", () => {
    const base = { campaignId: CAMP, action: "create" };
    expect(write!.check!({ ...base, title: "T", body: "B" })).toMatch(/category/);
    expect(write!.check!({ ...base, category: "history", body: "B" })).toMatch(/category/);
    expect(write!.check!({ ...base, category: "history", title: "T" })).toMatch(/category/);
    expect(write!.check!({ ...base, category: "npc", title: "T", body: "B" })).toMatch(/category/);
  });

  it("routes patch to PATCH /lore/:id and keeps patch-only fields in the body", () => {
    const args = { campaignId: CAMP, action: "patch", id: ENTRY, title: "New", pinned: true };
    expect(methodOf(write!, args)).toBe("PATCH");
    expect(write!.path(args)).toBe(`/api/campaigns/${CAMP}/lore/${ENTRY}`);
    expect(write!.body!(args)).toEqual({ title: "New", pinned: true });
    expect(write!.check!(args)).toBeNull();
    expect(write!.check!({ campaignId: CAMP, action: "patch", title: "No id" })).toMatch(/id/);
  });

  it("create never sends pinned (the create route does not take it)", () => {
    const args = { campaignId: CAMP, action: "create", category: "other", title: "T", body: "B", pinned: true };
    expect(write!.body!(args)).not.toHaveProperty("pinned");
  });

  it("routes delete to DELETE /lore/:id and refuses without confirm", () => {
    const args = { campaignId: CAMP, action: "delete", id: ENTRY, confirm: true };
    expect(methodOf(write!, args)).toBe("DELETE");
    expect(write!.path(args)).toBe(`/api/campaigns/${CAMP}/lore/${ENTRY}`);
    expect(write!.body!(args)).toBeUndefined();
    expect(write!.check!(args)).toBeNull();
    expect(write!.check!({ campaignId: CAMP, action: "delete", id: ENTRY })).toMatch(/confirm/);
    expect(write!.check!({ campaignId: CAMP, action: "delete", confirm: true })).toMatch(/id/);
  });

  it("exposes exactly the world lore categories in its schema", () => {
    const category = (write!.properties as { category: { enum: string[] } }).category;
    expect(category.enum).toEqual(["geography", "factions", "history", "magic", "culture", "religion", "other"]);
  });

  it("rejects an id with hostile characters when building the path", () => {
    expect(() => write!.path({ campaignId: CAMP, action: "delete", id: "../../settings" })).toThrow();
  });
});

describe("odm_get_facts", () => {
  it("is registered on the read scope", () => {
    expect(facts?.scope).toBe("read");
  });

  it("reads plain facts by default and secrets only when asked", () => {
    expect(facts!.method).toBe("GET");
    expect(facts!.path({ campaignId: CAMP })).toBe(`/api/campaigns/${CAMP}/facts`);
    expect(facts!.path({ campaignId: CAMP, secrets: true })).toBe(`/api/campaigns/${CAMP}/facts?secrets=1`);
    expect(facts!.path({ campaignId: CAMP, secrets: false })).toBe(`/api/campaigns/${CAMP}/facts`);
  });
});
