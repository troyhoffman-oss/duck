import { LOCAL, type Reach } from "./reach";

/** A body sent in aws-chunked framing, as restic's S3 client sends a PUT over plain HTTP, without the framing. */
function unchunk(body: Uint8Array) {
  const parts: Uint8Array[] = [];
  for (let at = 0; ; ) {
    const end = body.indexOf(13, at);
    const size = Number.parseInt(new TextDecoder().decode(body.subarray(at, end)).split(";")[0] ?? "", 16);
    if (!size) return new Uint8Array(Buffer.concat(parts));
    parts.push(body.subarray(end + 2, end + 2 + size));
    at = end + 2 + size + 2;
  }
}

/**
 * A stand-in for the firm's S3-compatible storage bucket, holding its objects in memory. It answers what
 * bun 1.4.4's S3 client and restic 0.20.0 send, measured: a path-style PUT, HEAD, GET, ranged GET and DELETE
 * of an object, the bucket's location and HEAD, and ListObjectsV2 for a prefix. restic retries an object's
 * answer without Last-Modified until it gives up, so every one has it. A request must be signed with access
 * key `key`; the signature itself is not checked.
 */
export function startBucket({ name, key, reach = LOCAL }: { name: string; key: string; reach?: Reach }) {
  const objects = new Map<string, Uint8Array>();
  const uploads: string[] = [];
  let received = 0;
  const server = Bun.serve({
    hostname: reach.bind,
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname).slice(`/${name}/`.length);
      if (!request.headers.get("authorization")?.includes(`Credential=${key}/`))
        return new Response("<Error><Code>InvalidAccessKeyId</Code></Error>", { status: 403 });
      if (url.searchParams.has("location"))
        return new Response('<?xml version="1.0" encoding="UTF-8"?><LocationConstraint/>');
      if (request.method === "PUT") {
        const body = new Uint8Array(await request.arrayBuffer());
        const sent = request.headers.get("x-amz-content-sha256")?.startsWith("STREAMING-")
          ? unchunk(body)
          : body;
        uploads.push(path);
        received += sent.length;
        objects.set(path, sent);
        return new Response(null, { headers: { etag: '"0"' } });
      }
      if (request.method === "DELETE") {
        objects.delete(path);
        return new Response(null, { status: 204 });
      }
      if (url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const contents = keys.map(
          (k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)?.length}</Size></Contents>`,
        );
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${name}</Name><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated>${contents.join("")}</ListBucketResult>`,
          { headers: { "content-type": "application/xml" } },
        );
      }
      const object = path === "" ? new Uint8Array() : objects.get(path);
      if (!object) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
      const headers = { "last-modified": new Date().toUTCString(), etag: '"0"' };
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
      if (!range) return new Response(object, { headers });
      const [from, to] = [Number(range[1]), range[2] ? Number(range[2]) + 1 : object.length];
      return new Response(object.subarray(from, to), {
        status: 206,
        headers: { ...headers, "content-range": `bytes ${from}-${to - 1}/${object.length}` },
      });
    },
  });
  return {
    name,
    url: `http://${reach.host}:${server.port}`,
    /** Every object in the bucket, by its key. */
    objects,
    /** The key of every upload, in order. */
    uploads,
    /** How many bytes every upload so far has carried. */
    received: () => received,
    stop: () => server.stop(true),
  };
}

export type Bucket = ReturnType<typeof startBucket>;
