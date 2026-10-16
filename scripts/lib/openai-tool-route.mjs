// How OpenAI runs function tools for a model, read from the 400 it answers
// when Chat Completions cannot carry them. Shared by the server
// (src/lib/dm/sampling-logic.ts) and the backend probe
// (scripts/lib/provider-capability-probe.mjs), so the admin panel's Test
// backend and a campaign turn can never disagree. Dependency-free.
//
// OpenAI's GPT-6 line reasons by default, and on /v1/chat/completions that
// cannot be combined with function tools (issue #129). Its refusal says
// what to do instead, so every model starts on Chat Completions and takes
// the route the refusal names; nothing is decided from a model's name,
// which would go stale with the next model OpenAI ships.
// Source: https://developers.openai.com/api/docs/guides/latest-model

/** @typedef {"chat" | "chat-no-reasoning" | "responses"} OpenAiToolRoute */

/**
 * The route a 400 body asks for, or null when it asks for nothing of the
 * kind. OpenAI spells it out: "Function tools with reasoning_effort are not
 * supported for gpt-6.1-sol in /v1/chat/completions. To use function tools,
 * use /v1/responses or set reasoning_effort to 'none'." Responses wins when
 * both are offered: it carries tools with reasoning left on for every model,
 * where "none" is refused by the models that need Responses anyway.
 * @param {string} body
 * @returns {OpenAiToolRoute | null}
 */
export function toolRouteFromError(body) {
  const text = String(body ?? "").slice(0, 4000);
  if (!text) return null;
  if (/\/v1\/responses|responses api/i.test(text)) return "responses";
  if (/reasoning_effort\s+to\s+['"]none['"]/i.test(text)) return "chat-no-reasoning";
  return null;
}
