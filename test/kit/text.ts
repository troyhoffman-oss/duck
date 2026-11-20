import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { FROM_CONTAINERS, freePort, until } from "./reach";

/** The protos Photon publishes with its client, at the version duck pins: the stand-in's wire contract. */
const PROTO = join(
  dirname(Bun.fileURLToPath(import.meta.resolve("@photon-ai/advanced-imessage"))),
  "..",
  "proto",
);

// biome-ignore lint/suspicious/noExplicitAny: proto-loader's messages and services are untyped.
type Loose = any;

/** A style over part of a text's words, as iMessage shows it. */
export type Style = { type: string; start: number; length: number };
/**
 * A text the coworker sent: the chat it went to, its words, the styles over them, its files, and when the
 * stand-in had it.
 */
export type Text = {
  chat: string;
  text: string;
  formatting: Style[];
  files: { name: string; bytes: Buffer }[];
  at: number;
};
/** What the coworker's line did in a chat besides texting: marked it read, or set typing on or off. */
export type Mark = { mark: "read" | "typing on" | "typing off"; chat: string; at: number };

/** The person's handle and a stranger's, as Photon writes a sender's address; mail addresses, so no number. */
const ROSA = "rosa@harbor.example";
const SAM = "sam@harbor.example";

/** A refusal as Photon's line gives one: a gRPC status, its words, and Photon's code in `error-code`. */
function refusal(code: grpc.status, details: string, photon: string) {
  const metadata = new grpc.Metadata();
  metadata.set("error-code", photon);
  return { code, details: `[spectrum-imessage] ${details}`, metadata } as grpc.ServiceError;
}

/**
 * A stand-in for Photon for one test: Spectrum's token call for one project on a shared line, and the line,
 * a gRPC server on Photon's own protos answering the calls the text door makes: the message stream with a
 * heartbeat on opening and every 30 s as Photon's (measured), uploads, downloads, and multipart sends, a
 * repeated client message id refused as Photon refuses it, and a chat's read marks and typing. The person and
 * a stranger text the coworker's line.
 */
export async function startText() {
  const project = randomUUID();
  const secret = randomBytes(24).toString("base64url");
  const token = randomBytes(24).toString("base64url");
  const streams = new Set<grpc.ServerWritableStream<Loose, Loose>>();
  const stored = new Map<string, { name: string; bytes: Buffer }>();
  const ids = new Set<string>();
  const sent: Text[] = [];
  const marks: Mark[] = [];
  let [sequence, opened] = [0, 0];
  const beats = setInterval(() => {
    for (const s of streams) s.write({ heartbeat: {} });
  }, 30_000);

  const loaded = loadSync(
    ["message_service", "attachment_service", "chat_service"].map((s) => `photon/imessage/v1/${s}.proto`),
    { includeDirs: [PROTO], keepCase: false, longs: Number, enums: String, defaults: false, oneofs: true },
  );
  const v1 = (grpc.loadPackageDefinition(loaded) as Loose).photon.imessage.v1;
  const authed = (call: { metadata: grpc.Metadata }) =>
    call.metadata.get("authorization")[0] === `Bearer ${token}`;
  const denied = refusal(grpc.status.UNAUTHENTICATED, "Missing authorization", "unauthorized");
  /** A unary call, refused unless it carries a token the stand-in minted. */
  const unary =
    (answer: (request: Loose) => object | grpc.ServiceError) =>
    (call: grpc.ServerUnaryCall<Loose, Loose>, done: grpc.sendUnaryData<Loose>) => {
      const got = authed(call) ? answer(call.request) : denied;
      return "code" in got ? done(got as grpc.ServiceError, null) : done(null, got);
    };

  const server = new grpc.Server();
  server.addService(v1.MessageService.service, {
    SubscribeMessageEvents: (call: grpc.ServerWritableStream<Loose, Loose>) => {
      if (!authed(call)) return void call.emit("error", denied);
      streams.add(call);
      opened += 1;
      call.write({ heartbeat: {} });
      call.on("cancelled", () => streams.delete(call));
      call.on("close", () => streams.delete(call));
    },
    SendMultipartMessage: unary((r) => {
      if (r.clientMessageId && ids.has(r.clientMessageId))
        return refusal(grpc.status.ALREADY_EXISTS, "Duplicate client message id", "duplicateMessage");
      if (r.clientMessageId) ids.add(r.clientMessageId);
      const parts = (r.parts ?? []) as {
        text?: string;
        formatting?: Style[];
        attachment?: { attachmentGuid: string; attachmentName?: string };
      }[];
      const files = parts.flatMap((p) => {
        const file = p.attachment && stored.get(p.attachment.attachmentGuid);
        return file ? [{ name: p.attachment?.attachmentName ?? file.name, bytes: file.bytes }] : [];
      });
      if (files.length !== parts.filter((p) => p.attachment).length)
        return refusal(grpc.status.NOT_FOUND, "No such attachment", "attachmentNotFound");
      const text = parts.flatMap((p) => (p.text === undefined ? [] : [p.text])).join("");
      // proto3 leaves a zero off the wire.
      const formatting = parts
        .flatMap((p) => p.formatting ?? [])
        .map(({ type, start = 0, length = 0 }) => ({ type, start, length }));
      sent.push({ chat: r.chatGuid, text, formatting, files, at: performance.now() });
      return { message: { guid: randomUUID(), isFromMe: true, content: { text, formatting } } };
    }),
  });
  server.addService(v1.ChatService.service, {
    MarkChatRead: unary((r) => {
      marks.push({ mark: "read", chat: r.chatGuid, at: performance.now() });
      return {};
    }),
    SetTyping: unary((r) => {
      marks.push({ mark: r.isTyping ? "typing on" : "typing off", chat: r.chatGuid, at: performance.now() });
      return {};
    }),
  });
  server.addService(v1.AttachmentService.service, {
    UploadAttachment: unary((r) => {
      const guid = randomUUID();
      stored.set(guid, { name: r.fileName, bytes: Buffer.from(r.data ?? []) });
      return { attachment: { guid, fileName: r.fileName, totalBytes: r.data?.length ?? 0 } };
    }),
    DownloadAttachment: (call: grpc.ServerWritableStream<Loose, Loose>) => {
      const file = stored.get(call.request.attachmentGuid);
      if (!authed(call)) return void call.emit("error", denied);
      if (!file)
        return void call.emit(
          "error",
          refusal(grpc.status.NOT_FOUND, "No such attachment", "attachmentNotFound"),
        );
      const half = file.bytes.length >> 1;
      call.write({ header: { attachment: { guid: call.request.attachmentGuid, fileName: file.name } } });
      for (const chunk of [file.bytes.subarray(0, half), file.bytes.subarray(half)])
        call.write({ primaryChunk: chunk });
      call.end();
    },
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(`${FROM_CONTAINERS.bind}:0`, grpc.ServerCredentials.createInsecure(), (error, bound) =>
      error ? reject(error) : resolve(bound),
    ),
  );

  const spectrum = Bun.serve({
    hostname: FROM_CONTAINERS.bind,
    port: freePort(),
    fetch(request) {
      if (
        new URL(request.url).pathname !== `/projects/${project}/imessage/tokens` ||
        request.method !== "POST"
      )
        return new Response("not found", { status: 404 });
      if (request.headers.get("authorization") !== `Basic ${btoa(`${project}:${secret}`)}`)
        return Response.json({ succeed: false }, { status: 401 });
      return Response.json({ succeed: true, data: { type: "shared", token, expiresIn: 900 } });
    },
  });

  /** `from` texts the coworker's line `text`, with `files`, in their direct chat with it. Returns when. */
  function texted(from: string, text: string, files: { name: string; bytes: string; type?: string }[] = []) {
    const attachments = files.map((f) => {
      const guid = randomUUID();
      stored.set(guid, { name: f.name, bytes: Buffer.from(f.bytes) });
      return { guid, fileName: f.name, mimeType: f.type ?? "text/plain", totalBytes: f.bytes.length };
    });
    const at = { seconds: Math.floor(Date.now() / 1000) };
    const message = {
      guid: randomUUID(),
      // Apple's text holds an object replacement character where each attachment sits.
      content: { text: `${String.fromCodePoint(0xfffc).repeat(files.length)}${text}`, attachments },
      sender: { address: from, service: "CHAT_SERVICE_TYPE_IMESSAGE" },
      dateCreated: at,
    };
    const began = performance.now();
    sequence += 1;
    const changed = { chatGuid: `iMessage;-;${from}`, occurredAt: at, messageReceived: { message } };
    for (const s of streams) s.write({ sequence, messageChanged: changed });
    return began;
  }

  const taken = new Set<number>();
  return {
    /** The coworker's text door as duck's setup writes it, pointing at the stand-in. */
    door: {
      kind: "text",
      address: `http://${FROM_CONTAINERS.host}:${spectrum.port}/projects/${project}`,
      line: `http://${FROM_CONTAINERS.host}:${port}`,
      key: "HARBOR_PHOTON_SECRET",
      auth: "HARBOR_ROSA_HANDLE",
    },
    /** The secrets that door names: the project's secret and the person's own handle. */
    secrets: { HARBOR_PHOTON_SECRET: secret, HARBOR_ROSA_HANDLE: ROSA },
    /** Waits until the coworker's line has its stream open. */
    online: (seconds = 60) => until("the text door's stream open", () => streams.size > 0, seconds),
    /** How many streams the coworker's line has opened. */
    opened: () => opened,
    /** Ends every open stream, as Photon does when it ends one. */
    end: () => {
      for (const s of streams) s.end();
    },
    person: {
      send: (text: string, files: { name: string; bytes: string; type?: string }[] = []) =>
        texted(ROSA, text, files),
      /** The coworker's next text to the person not yet taken, waiting up to `seconds` for it. */
      async next(seconds: number): Promise<Text> {
        const mine = () => sent.findIndex((m, i) => m.chat === `any;-;${ROSA}` && !taken.has(i));
        await until("the coworker's next text", () => mine() !== -1, seconds);
        const found = mine();
        taken.add(found);
        return sent[found] as Text;
      },
    },
    stranger: { send: (text: string) => texted(SAM, text) },
    /** Every text the coworker sent, to anyone. */
    sent,
    /** Every read mark and typing change the coworker's line made, in order. */
    marks,
    [Symbol.asyncDispose]: async () => {
      clearInterval(beats);
      server.forceShutdown();
      await spectrum.stop(true);
    },
  };
}

export type TextLine = Awaited<ReturnType<typeof startText>>;
