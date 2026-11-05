/** Keep terminal choices terminal, while retaining late usage and other choices. */
export const createCompletionBoundary = () => {
  const finished = new Set<number>();
  let buffer = "";

  const event = (frame: string): string => frame.replace(/^data:([^\r\n]*)/gmu, (line, payload: string) => {
    let value: unknown;
    try { value = JSON.parse(payload); } catch { return line; }
    if (!value || typeof value !== "object" || !Array.isArray((value as { choices?: unknown }).choices)) return line;
    const record = value as { choices: Array<Record<string, unknown>> };
    let changed = false;
    const choices = record.choices.map((choice) => {
      if (!choice || typeof choice !== "object" || typeof choice.index !== "number") return choice;
      const closed = finished.has(choice.index);
      if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) finished.add(choice.index);
      if (!closed || !choice.delta || typeof choice.delta !== "object" || Array.isArray(choice.delta)) return choice;
      const delta = { ...(choice.delta as Record<string, unknown>) };
      // No string matching: genuine content (including go-plus) before finish survives.
      for (const key of ["content", "refusal"]) {
        if (typeof delta[key] !== "string" || delta[key].length === 0) continue;
        delete delta[key];
        changed = true;
      }
      return { ...choice, delta };
    });
    return changed ? `data: ${JSON.stringify({ ...record, choices })}` : line;
  });

  return {
    transform(chunk: string): string {
      buffer += chunk;
      let result = "";
      let separator: RegExpExecArray | null;
      while ((separator = /\r\n\r\n|\n\n|\r\r/u.exec(buffer))) {
        const end = separator.index + separator[0].length;
        result += event(buffer.slice(0, end));
        buffer = buffer.slice(end);
      }
      return result;
    },
    flush(): string {
      const remaining = buffer;
      buffer = "";
      return event(remaining);
    },
  };
};
