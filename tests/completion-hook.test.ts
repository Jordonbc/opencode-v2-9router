import assert from "node:assert/strict";
import test from "node:test";
import { registerCompletionBoundary } from "../src/omniroute/completion-hook.js";

const setup = async (providerID = "omniroute") => {
  let callback: (input: any) => void = () => { throw new Error("not registered"); };
  await registerCompletionBoundary({ hook: async (name: string, cb: typeof callback, options: unknown) => {
    assert.equal(name, "http.response");
    assert.deepEqual(options, { providerID });
    callback = cb;
  } }, providerID, () => assert.fail("registration failed"));
  return callback;
};
const frame = (delta: unknown, finish_reason: unknown = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const body = frame({ content: "go-plus café" }) + frame({}, "stop") + frame({ content: "go-plus" });
const expected = frame({ content: "go-plus café" }) + frame({}, "stop") + frame({});
const input = (response: Response, providerID = "omniroute", id = "opencode-go/beam-free", kind = "primary") => ({ model: { providerID, id }, response, kind });

test("HTTP hook fixes primary and title responses with split UTF-8 and corrected headers", async () => {
  const cb = await setup();
  for (const kind of ["primary", "title"]) {
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    const event = input(new Response(stream, { status: 201, statusText: "Created", headers: { "content-type": "TEXT/EVENT-STREAM", "content-length": "999", "content-encoding": "gzip", "transfer-encoding": "chunked", "x-test": "kept" } }), "omniroute", "opencode-go/beam-free", kind);
    cb(event);
    assert.equal(await event.response.text(), expected);
    assert.equal(event.response.status, 201);
    assert.equal(event.response.statusText, "Created");
    for (const h of ["content-length", "content-encoding", "transfer-encoding"]) assert.equal(event.response.headers.has(h), false);
    assert.equal(event.response.headers.get("x-test"), "kept");
  }
});

test("preserves unrelated providers, routes, non-SSE, missing types and bodyless responses", async () => {
  const cb = await setup();
  const sse = () => new Response(body, { headers: { "content-type": "text/event-stream" } });
  for (const event of [input(sse(), "other"), input(sse(), "omniroute", "opencode-go/other"), input(new Response(body)), input(new Response(body, { headers: { "content-type": "application/json" } })), input(new Response(null, { status: 204 }))]) {
    const original = event.response;cb(event);assert.equal(event.response, original);
  }
});

test("custom provider identity is respected; state is fresh for every request", async () => {
  const cb = await setup("custom");
  const a = input(new Response(body, { headers: { "content-type": "text/event-stream" } }), "custom");cb(a);assert.equal(await a.response.text(), expected);
  const partial = frame({ content: "go-plus" }).trimEnd();
  const b = input(new Response(partial, { headers: { "content-type": "text/event-stream" } }), "custom");cb(b);assert.equal(await b.response.text(), partial);
  const empty = input(new Response("", { headers: { "content-type": "text/event-stream" } }), "custom");cb(empty);assert.equal(await empty.response.text(), "");
});

test("propagates stream errors and consumer cancellation", async () => {
  const cb = await setup();
  const failure = new Error("synthetic read failure");
  const broken = input(new Response(new ReadableStream({ start(c) { c.error(failure); } }), { headers: { "content-type": "text/event-stream" } }));
  cb(broken);await assert.rejects(broken.response.text(), /synthetic read failure/);
  let cancelled: unknown;
  const event = input(new Response(new ReadableStream({ cancel(reason) { cancelled = reason; } }), { headers: { "content-type": "text/event-stream" } }));
  cb(event);await event.response.body!.cancel("consumer stopped");
  await new Promise((resolve) => setImmediate(resolve));assert.equal(cancelled, "consumer stopped");
});

test("missing hooks are harmless and failed registration warns without exception details", async () => {
  const warnings: string[] = [];
  for (const session of [undefined, null, 1, {}, { hook: 1 }]) await registerCompletionBoundary(session, "omniroute", (s) => warnings.push(s));
  assert.equal(warnings.length, 0);
  await registerCompletionBoundary({ hook: async () => { throw new Error("secret"); } }, "omniroute", (s) => warnings.push(s));
  assert.deepEqual(warnings, ["opencode-9router-v2: omniroute completion boundary unavailable; continuing"]);
});
