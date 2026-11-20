// A box on harbor's calendar plug where its list tool answers inside a wrapper object, `{ "value": [rows] }`
// (SPEC part 1). duck reads a polled tool's rows after each box's `after` has shaped its result.

type Result = { content: { type: string; text?: string }[]; isError?: boolean };

/** Gives duck the rows inside the calendar's wrapper. */
export function after(tool: string, _input: unknown, result: Result) {
  if (tool !== "list_events") return result;
  const text = (c: Result["content"][number]) => JSON.stringify(JSON.parse(c.text ?? "{}").value);
  return { ...result, content: result.content.map((c) => ({ ...c, text: text(c) })) };
}
