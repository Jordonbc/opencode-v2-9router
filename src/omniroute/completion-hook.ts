import type { Plugin } from "@opencode/plugin";
import { createCompletionBoundary } from "./completion-boundary.js";

/** Native HTTP transport hook, shared by primary and auxiliary title requests. */
export const registerCompletionBoundary = async (
  session: unknown,
  providerID: string,
  warn: (message: string) => void,
): Promise<void> => {
  if (!session || typeof session !== "object" || typeof (session as { hook?: unknown }).hook !== "function") return;
  try {
    await (session as Plugin.Context["session"]).hook("http.response", (input) => {
      if (input.model.providerID !== providerID || input.model.id !== "opencode-go/beam-free") return;
      const response = input.response;
      if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) return;
      const boundary = createCompletionBoundary();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          const text = boundary.transform(decoder.decode(chunk, { stream: true }));
          if (text) controller.enqueue(encoder.encode(text));
        },
        flush(controller) {
          const text = boundary.transform(decoder.decode()) + boundary.flush();
          if (text) controller.enqueue(encoder.encode(text));
        },
      }));
      const headers = new Headers(response.headers);
      for (const name of ["content-length", "content-encoding", "transfer-encoding"]) headers.delete(name);
      input.response = new Response(body, { status: response.status, statusText: response.statusText, headers });
    }, { providerID });
  } catch {
    warn("opencode-9router-v2: omniroute completion boundary unavailable; continuing");
  }
};
