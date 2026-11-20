// A box on harbor's mail plug (SPEC part 9). The gate runs `before` on each call to one of the plug's
// tools, ahead of the call, then `askFirst` on the call as `before` shaped it, and `after` on its result. A
// box picks the tools it acts on.

type Json = Record<string, unknown>;
type Result = { content: { type: string; text: string }[]; isError?: boolean };

/** Asks for the fields a coworker reads unless it names its own, and refuses a search too big to read. */
export function before(tool: string, input: Json) {
  if (tool !== "find_mail") return input;
  if (Number(input.top) > 25) throw new Error("find_mail reads at most 25 mails at a time; ask for fewer.");
  return { select: ["from", "subject", "received", "body"], ...input };
}

/** Asks first before a draft is saved for someone outside the firm. */
export const askFirst = (tool: string, input: Json) =>
  tool === "save_draft" && !String(input.to).endsWith("@harbor.example");

/** Turns the HTML in mail's bodies into plain text. */
export function after(tool: string, _input: Json, result: Result) {
  if (tool !== "find_mail") return result;
  const plain = (html: string) =>
    html
      .replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, " ")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
  return { ...result, content: result.content.map((c) => ({ ...c, text: plain(c.text) })) };
}
