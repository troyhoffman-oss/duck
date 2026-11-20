// A box for harbor's mail plug where the mail service signs each event it pushes and names the person it is
// for (SPEC part 1). The service sends a JSON body of `ref`, the mail's own id, `about`, its thread's id,
// `payload` and `person`, and in `x-signature` the hex HMAC-SHA256 of that raw body made with the push key.
import { createHmac, timingSafeEqual } from "node:crypto";

export function event(body: string, headers: Headers, key: string) {
  const sent = Buffer.from(headers.get("x-signature") ?? "", "hex");
  const made = createHmac("sha256", key).update(body).digest();
  if (sent.length !== made.length || !timingSafeEqual(sent, made)) throw new Error("the signature is wrong");
  return JSON.parse(body) as { ref: string; about?: string; payload: unknown; person?: string };
}
