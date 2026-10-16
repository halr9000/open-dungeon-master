import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-stream-repeat-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
register("./lib/register-alias.mjs", import.meta.url);

const { requestCustomMessage, requestLocalMessage } = await import("../src/lib/model-client.ts");
const { createStreamRepetitionGuard, cutRepetition } = await import("../src/lib/stream-repetition.ts");
const { extractStoryText } = await import("../src/lib/story-prompt.ts");
const realFetch = globalThis.fetch;
const paragraph = `The Archmage's eyes flare, a spark of humor dancing in the blue light. "It is a place of many doors. Choose yours wisely, Master Flamefinger. Even a scholar must know when to put down the book and pick up a glass of wine."`;
assert.ok(paragraph.length >= 160);
const second = "The torches gutter as a cold draft sweeps through the hall; somewhere below, chains rattle against stone and a low voice begins to count the hours until dawn arrives.";
const chant = "Ia, ia, the drowned one wakes beneath the black water; ia, ia, the tide returns what the land has stolen, and the moon bleeds silver on the altar of the deep.";

// Where the guard says a text's loop has its first copy end, the same
// however the text is cut into deltas: one character at a time, a few, a
// line's worth, or all at once.
function firstCopyEnd(text) {
  let found;
  for (const size of [1, 3, 23, 160, text.length]) {
    const guard = createStreamRepetitionGuard();
    for (const piece of text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"))) {
      if (guard.push(piece)) break;
    }
    found ??= guard.firstCopyEnd;
    assert.equal(guard.firstCopyEnd, found, `deltas of ${size} characters changed the verdict`);
  }
  return found;
}

// The loop shapes small local models fall into, each cut after its first
// copy whatever separates the copies.
{
  const loops = [
    ["a two-paragraph cycle", (paragraph + "\n\n" + second + "\n\n").repeat(6), paragraph + "\n\n" + second],
    ["a paragraph and a closing question", (paragraph + "\n\nWhat do you do?\n\n").repeat(6), paragraph + "\n\nWhat do you do?"],
    ["copies a single newline apart", (paragraph + "\n").repeat(6), paragraph],
    ["copies a whitespace-only line apart", (paragraph + "\n \n").repeat(6), paragraph],
    ["copies a tab-only line apart", (paragraph + "\n\t\n").repeat(6), paragraph],
    ["copies with a rule between", (paragraph + "\n\n---\n\n").repeat(6), paragraph + "\n\n---"],
    ["a loop after an opening sentence on its line", "The door opens. " + (paragraph + "\n\n").repeat(4), "The door opens. " + paragraph],
  ];
  for (const [name, text, kept] of loops) {
    const end = firstCopyEnd(text);
    assert.ok(end > 0, `${name} is a loop`);
    assert.equal(text.slice(0, end).trim(), kept, `${name} keeps its first copy`);
    assert.equal(cutRepetition(text)?.trim(), kept);
    assert.equal(cutRepetition(`<think>The player wants a scene.</think>${text}`)?.trim(), `<think>The player wants a scene.</think>${kept}`);
  }

  // A sentence looping with no newline at all.
  const sentence = "The torches gutter and the shadows lengthen along the hall as the cold wind rises. ";
  const looped = sentence.repeat(40);
  const end = firstCopyEnd(looped);
  assert.ok(end > 0 && end < sentence.length * 4, "a loop with no newline is caught near its start");
  assert.equal(looped.slice(0, end), sentence.repeat(Math.ceil(160 / sentence.length)), "and cut after whole copies");

  // Narration wrapped in the JSON story object carries its breaks as a
  // literal \n; the cut closes the object so its text still reads.
  const wrapped = `{"storyText":"${(paragraph.replace(/"/g, '\\"') + "\\n\\n").repeat(8)}"}`;
  assert.ok(firstCopyEnd(wrapped) > 0, "a loop inside a JSON story object is caught");
  assert.equal(extractStoryText(cutRepetition(wrapped)), paragraph, "the cut story object reads as the first copy");
  const wrappedSentence = `{"storyText":"${sentence.repeat(40)}"}`;
  assert.equal(extractStoryText(cutRepetition(wrappedSentence)), sentence.repeat(2).trim());
  // A loop inside a <think> block the server left in the reply is the
  // model's reasoning: there is no story in its first copy to keep.
  assert.equal(cutRepetition(`<think>\n${loops[0][1]}`), null);
  console.log("ok: two-paragraph cycles, a closing question, any separator, no newline and JSON-wrapped loops halt, and the guard finds where their first copy ends");
}

// Writing that repeats without looping.
{
  const verses = [
    "Verse one of the ballad tells of Bram and the bandit at the ford, and the river ran red that day.",
    "Verse two of the ballad tells of the long march north through the snow and the wolves at its heels.",
    "Verse three tells of the return, and the feast in the hall of the Archmage when the snows had gone.",
  ];
  const fine = [
    ["short dialogue repeated", "Yes.\n\n".repeat(20)],
    ["short dialogue repeated on one line", "Yes. ".repeat(20)],
    ["a refrain between different verses", verses.flatMap((verse) => [verse, chant]).join("\n\n") + "\n\n"],
    ["varied narration", [paragraph, second, chant, "The goblin shrieks and swings its rusty blade at you."].join("\n\n") + "\n\n"],
    ["a three-item list", "You find:\n- a rusty dagger\n- a coil of rope\n- a hooded lantern\n"],
    ["a roster of identical entries", "The muster roll reads:\n" + "- A goblin spearman in a dented helm, crouched behind the barricade with a sling.\n".repeat(6) + "\nWhat do you do?"],
    ["a paragraph said twice", second + "\n\n" + paragraph + "\n\n" + paragraph + "\n\n"],
  ];
  for (const [name, text] of fine) {
    assert.equal(firstCopyEnd(text), -1, `${name} is not a loop`);
    assert.equal(cutRepetition(text), undefined);
  }
  console.log("ok: short repeated lines, a refrain between verses, varied narration, lists and rosters are left alone");
}

const event = (delta) => `data: ${JSON.stringify({ choices: [{ delta: typeof delta === "string" ? { content: delta } : delta }] })}\n\n`;
const toolEvent = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "request_roll", arguments: "{}" } }] } }] })}\n\n`;

async function callWithDeltas(deltas, holdOpen = false, toolFirst = false, options = {}) {
  let signal;
  let cancelled = false;
  let closeTimer;
  globalThis.fetch = async (_url, init) => {
    signal = init.signal;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode((toolFirst ? toolEvent : "") + deltas.map(event).join("") + toolEvent + "data: [DONE]\n\n"));
        if (holdOpen) {
          closeTimer = setTimeout(() => { try { controller.close(); } catch {} }, 200);
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
        clearTimeout(closeTimer);
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  };
  let shown = "";
  const result = await requestCustomMessage(
    "http://127.0.0.1:8080/v1",
    "test-model",
    "",
    [{ role: "user", content: "Continue the scene." }],
    { ...options, onDelta: (text) => { shown += text; } },
  );
  return { result, shown, signal, cancelled };
}

const tool = { type: "function", function: { name: "request_roll", description: "Roll", parameters: { type: "object", properties: {} } } };
const loop = (paragraph + "\n\n").repeat(5);

try {
  const repeated = await callWithDeltas(
    (paragraph + "\n\n").repeat(5).match(/.{1,37}/gs),
    true,
    true,
  );
  assert.ok(repeated.result.error, "a repeating long paragraph halts the model call");
  assert.match((await repeated.result.error.json()).error, /repeat/i);
  assert.equal(repeated.signal.aborted, true, "the upstream request is aborted");
  assert.equal(repeated.cancelled, true, "the buffered stream reader is cancelled");
  assert.equal(repeated.result.message, undefined, "partial tool calls cannot be returned as a completed reply");
  assert.ok(repeated.shown.length < paragraph.length * 4, "the loop is cut near its start");
  console.log("ok: repeated long paragraphs halt and cancel the stream before tool calls are accepted");

  const punctuationShift = await callWithDeltas([
    paragraph.replace("Archmage's", "Archmage’s") + "\n\n",
    (paragraph + "\n\n").repeat(4),
  ]);
  assert.ok(punctuationShift.result.error, "a punctuation change before the stable loop does not hide it");
  assert.match((await punctuationShift.result.error.json()).error, /repeat/i);
  console.log("ok: the sample's curly-to-straight punctuation change still leads to a halt");

  const crlf = await callWithDeltas((paragraph + "\r\n\r\n").repeat(4).match(/.{1,31}/gs));
  assert.ok(crlf.result.error, "CRLF paragraph boundaries also halt the loop");
  assert.match((await crlf.result.error.json()).error, /repeat/i);
  console.log("ok: CRLF paragraph boundaries are detected across arbitrary deltas");

  const normal = await callWithDeltas([
    paragraph + "\n\n",
    "The iron door opens toward a quiet staircase with a view of the harbor.\n\n",
    "A bell sounds from the tower and the watch changes in the square.\n\n",
  ]);
  assert.equal(normal.result.error, undefined);
  assert.equal(normal.result.message?.content, normal.shown);
  assert.equal(normal.result.message?.tool_calls?.[0]?.function?.name, "request_roll");
  console.log("ok: varied narration still streams and accepts complete tool calls");

  const short = await callWithDeltas(["Yes.\n\n".repeat(20)]);
  assert.equal(short.result.error, undefined);
  assert.equal(short.result.message?.content, "Yes.\n\n".repeat(20));
  console.log("ok: short repeated dialogue does not trip the guard");

  let localSignal;
  globalThis.fetch = async (_url, init) => {
    localSignal = init.signal;
    const content = (paragraph + "\n\n").repeat(4);
    const lines = [...content.match(/.{1,41}/gs)].map((piece) => JSON.stringify({ message: { content: piece } }) + "\n").join("");
    return new Response(lines, { headers: { "Content-Type": "application/x-ndjson" } });
  };
  const local = await requestLocalMessage("test-model", [{ role: "user", content: "Continue." }], { onDelta: () => {} });
  assert.ok(local.error, "Ollama's streamed narration also halts");
  assert.match((await local.error.json()).error, /repeat/i);
  assert.equal(localSignal.aborted, true);
  assert.equal(local.message, undefined);
  console.log("ok: Ollama NDJSON also aborts a repeated passage");

  // OpenAI's own host starts every model on Chat Completions and learns the
  // Responses route from the 400 that names it, so the stub refuses Chat
  // with that answer and streams the repeated passage on the retry.
  const urls = [];
  let responsesSignal;
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    if (String(url).endsWith("/chat/completions")) {
      return Response.json({ error: { message: "Function tools with reasoning_effort are not supported for test-reasoner in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.", type: "invalid_request_error", param: "reasoning_effort", code: null } }, { status: 400 });
    }
    responsesSignal = init.signal;
    const content = (paragraph + "\n\n").repeat(4);
    const events = [...content.match(/.{1,43}/gs)]
      .map((piece) => `data: ${JSON.stringify({ type: "response.output_text.delta", delta: piece })}\n\n`)
      .join("");
    return new Response(events + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  };
  const responses = await requestCustomMessage("https://api.openai.com/v1", "test-reasoner", "sk-test", [{ role: "user", content: "Continue." }], { tools: [tool], onDelta: () => {} });
  assert.ok(urls.some((url) => url.endsWith("/responses")), `the case reached /v1/responses: ${urls.join(", ")}`);
  assert.ok(responses.error, "Responses API streamed narration also halts");
  assert.match((await responses.error.json()).error, /repeat/i);
  assert.equal(responsesSignal.aborted, true);
  assert.equal(responses.message, undefined);
  console.log("ok: Responses API also aborts a repeated passage");

  // A call that may only narrate (the turn's forced last call, its
  // tools-closed rescue) keeps the first copy as its reply instead of failing
  // the turn. Its leaked tool call is dropped with the rest of the stream.
  const closed = await callWithDeltas(loop.match(/.{1,37}/gs), true, true, { tools: [tool], toolChoice: "none" });
  assert.equal(closed.result.error, undefined, "a narration-only loop does not fail the call");
  assert.equal(closed.result.message?.content, paragraph, "its first copy is the reply");
  assert.equal(closed.result.message?.tool_calls, undefined, "no tool call comes back from a cut stream");
  assert.equal(closed.result.finishReason, "repetition");
  assert.equal(closed.signal.aborted, true, "the backend is still stopped");
  assert.equal(closed.cancelled, true);
  const asked = await callWithDeltas(loop.match(/.{1,37}/gs), false, false, { tools: [tool], toolChoice: "auto" });
  assert.match((await asked.result.error.json()).code, /stream_repetition/, "a call that could still choose tools fails instead");

  globalThis.fetch = async () =>
    new Response([...loop.match(/.{1,41}/gs)].map((piece) => JSON.stringify({ message: { content: piece } }) + "\n").join(""));
  const localClosed = await requestLocalMessage("test-model", [{ role: "user", content: "Continue." }], { tools: [tool], toolChoice: "none", onDelta: () => {} });
  assert.equal(localClosed.message?.content, paragraph, "Ollama keeps the first copy of a narration-only loop");

  globalThis.fetch = async () =>
    new Response(
      [...loop.match(/.{1,43}/gs)].map((piece) => `data: ${JSON.stringify({ type: "response.output_text.delta", delta: piece })}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    );
  const responsesClosed = await requestCustomMessage("https://api.openai.com/v1", "test-reasoner", "sk-test", [{ role: "user", content: "Continue." }], { tools: [tool], toolChoice: "none", onDelta: () => {} });
  assert.equal(responsesClosed.message?.content, paragraph, "the Responses route keeps the first copy too");

  const wrapped = `{"storyText":"${(paragraph.replace(/"/g, '\\"') + "\\n\\n").repeat(5)}`;
  const story = await callWithDeltas(wrapped.match(/.{1,29}/gs), false, false, { toolChoice: "none" });
  assert.equal(extractStoryText(story.result.message?.content), paragraph, "a JSON story reply cut mid-loop still reads as its first copy");
  const unclosed = await callWithDeltas(("<think>\n" + loop).match(/.{1,37}/gs), false, false, { toolChoice: "none" });
  assert.equal((await unclosed.result.error.json()).code, "stream_repetition", "a loop inside a <think> block in the reply is no narration to keep");
  console.log("ok: a narration-only call keeps the first copy of a loop as its reply; a tool-decision call still fails");

  // A reply that arrives whole (a continue, a reroll, an expansion, the
  // guard's rewrite, a recap) is cut the same way when it may only narrate;
  // bookkeeping calls, which ask for JSON with no toolChoice, keep theirs.
  globalThis.fetch = async () => Response.json({ choices: [{ message: { role: "assistant", content: loop }, finish_reason: "stop" }] });
  const whole = await requestCustomMessage("http://127.0.0.1:8080/v1", "test-model", "", [{ role: "user", content: "Continue." }], { toolChoice: "none" });
  assert.equal(whole.message?.content, paragraph, "a whole narration reply keeps only its first copy");
  assert.equal(whole.finishReason, "repetition");
  const bookkeeping = await requestCustomMessage("http://127.0.0.1:8080/v1", "test-model", "", [{ role: "user", content: "Summarise." }], {});
  assert.equal(bookkeeping.message?.content, loop, "a call that is not narration is left as it came");
  const varied = [paragraph, second, chant].join("\n\n");
  globalThis.fetch = async () => Response.json({ choices: [{ message: { role: "assistant", content: varied }, finish_reason: "stop" }] });
  const plain = await requestCustomMessage("http://127.0.0.1:8080/v1", "test-model", "", [{ role: "user", content: "Continue." }], { toolChoice: "none" });
  assert.equal(plain.message?.content, varied);
  assert.equal(plain.finishReason, "stop");
  globalThis.fetch = async () => Response.json({ choices: [{ message: { role: "assistant", content: "<think>\n" + loop }, finish_reason: "length" }] });
  const thoughtWhole = await requestCustomMessage("http://127.0.0.1:8080/v1", "test-model", "", [{ role: "user", content: "Continue." }], { toolChoice: "none" });
  assert.equal((await thoughtWhole.error.json()).code, "stream_repetition", "a whole reply looping inside its <think> block keeps nothing");

  globalThis.fetch = async () => Response.json({ message: { role: "assistant", content: loop } });
  const localWhole = await requestLocalMessage("test-model", [{ role: "user", content: "Continue." }], { toolChoice: "none" });
  assert.equal(localWhole.message?.content, paragraph, "Ollama's whole reply is cut too");

  globalThis.fetch = async () => Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: loop }] }] });
  const responsesWhole = await requestCustomMessage("https://api.openai.com/v1", "test-reasoner", "sk-test", [{ role: "user", content: "Continue." }], { toolChoice: "none" });
  assert.equal(responsesWhole.message?.content, paragraph, "and so is the Responses route's");
  console.log("ok: a whole narration reply that loops keeps its first copy on every route; other calls are untouched");

  // A loop in the reasoning channel never reaches the table but runs to the
  // output cap all the same, so it stops the call. With nothing to keep, it
  // fails even a call that may only narrate.
  const thinking = loop.match(/.{1,37}/gs);
  for (const field of ["reasoning_content", "reasoning"]) {
    const thought = await callWithDeltas([...thinking.map((piece) => ({ [field]: piece })), "The door opens."], true, false, { toolChoice: "none" });
    assert.ok(thought.result.error, `a loop in ${field} stops the call`);
    assert.equal((await thought.result.error.json()).code, "stream_repetition");
    assert.equal(thought.signal.aborted, true);
    assert.equal(thought.cancelled, true);
    assert.equal(thought.shown, "", "the reasoning never reached the table");
  }
  const reasoned = await callWithDeltas([{ reasoning_content: [paragraph, second, chant].join("\n\n") }, "The door opens."]);
  assert.equal(reasoned.result.message?.content, "The door opens.", "reasoning that does not loop is left alone");
  assert.equal(reasoned.shown, "The door opens.");

  globalThis.fetch = async () =>
    new Response(thinking.map((piece) => JSON.stringify({ message: { content: "", thinking: piece } }) + "\n").join(""));
  const localThought = await requestLocalMessage("test-model", [{ role: "user", content: "Continue." }], { onDelta: () => {} });
  assert.equal((await localThought.error.json()).code, "stream_repetition", "Ollama's thinking loop stops the call");

  let shownResponses = "";
  globalThis.fetch = async () =>
    new Response(
      thinking.map((piece) => `data: ${JSON.stringify({ type: "response.reasoning_text.delta", delta: piece })}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    );
  const responsesThought = await requestCustomMessage("https://api.openai.com/v1", "test-reasoner", "sk-test", [{ role: "user", content: "Continue." }], { toolChoice: "none", onDelta: (text) => { shownResponses += text; } });
  assert.equal((await responsesThought.error.json()).code, "stream_repetition", "a Responses reasoning loop stops the call");
  assert.equal(shownResponses, "");
  console.log("ok: a loop in the reasoning channel stops the call on Chat Completions, Ollama and the Responses route");
} finally {
  globalThis.fetch = realFetch;
  removeTempDir(dir);
}
