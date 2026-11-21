import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Reach, Trouble } from "./reach";

/** The page duck ships for a person to land on after they sign in, which a firm hosts where it likes. */
export const PAGE = join(import.meta.dir, "..", "..", "signin", "index.html");

/** A request to the stand-in's token address, as it judged it. */
export type TokenRequest = {
  grant: string;
  at: number;
  /** Whether it was given what it asked for. */
  ok: boolean;
  /** The service's own words for why not, where it refused. */
  refused?: string;
  /** Whether it carried the client's secret, and the redirect address it named, if any. */
  secret: boolean;
  redirect?: string;
};

/** What one account signed in to the stand-in holds: its access and refresh tokens, newest last. */
type Grant = { account: string; access: string; refresh: string; live: boolean; revoked: boolean };

/** A code the stand-in issued: whose, for which challenge and redirect, and whether it is still good. */
type Code = { account: string; challenge: string; redirect: string; used: boolean; spoiled: boolean };

/**
 * A stand-in for a service a person signs in to with OAuth 2's authorization code and PKCE (RFC 6749, RFC
 * 7636), as a firm's plug wants each person's sign-in: an authorize address that signs in the account the
 * person's browser holds, consents for it and sends them to the page the link names with a code and the
 * link's state; a token address that trades a code for an access token and a refresh token only with the
 * code's own verifier and the client's secret, and renews an access token with a refresh token; and, at
 * /page/, duck's page as a firm hosts it. A code is good once, until the service spoils it. Its codes hold
 * characters an address must carry encoded, as real services' do. Each sign-in it issues carries an OpenID
 * id_token naming the account by its email, unsigned, as a stand-in has no keys to sign with.
 */
export function startSignin({
  reach,
  client,
  secret,
  trouble = new Trouble(),
}: {
  reach: Reach;
  client: string;
  secret: string;
  trouble?: Trouble;
}) {
  const codes = new Map<string, Code>();
  const grants: Grant[] = [];
  const tokens: TokenRequest[] = [];
  /** Every link followed to the authorize address, as the service saw it. */
  const authorized: URL[] = [];
  /** How many token requests to come the service fails, and the requests it holds until a test lets them go. */
  let down = 0;
  let held: { opened: Promise<void>; open: () => void } | undefined;
  const random = (bytes: number) => randomBytes(bytes).toString("base64url");
  const refuse = (error: string, description: string) =>
    Response.json({ error, error_description: description }, { status: 400 });

  function authorize(url: URL, account: string | null) {
    authorized.push(url);
    const given = (name: string) => url.searchParams.get(name) ?? "";
    if (!account) return new Response("nobody is signed in", { status: 401 });
    if (given("client_id") !== client) return new Response("no such client", { status: 400 });
    if (given("response_type") !== "code" || given("code_challenge_method") !== "S256" || !given("state"))
      return new Response("the link lacks what a code with PKCE needs", { status: 400 });
    const code = `4/${randomBytes(30).toString("base64")}`;
    codes.set(code, {
      account,
      challenge: given("code_challenge"),
      redirect: given("redirect_uri"),
      used: false,
      spoiled: false,
    });
    const back = new URL(given("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", given("state"));
    return new Response(null, { status: 302, headers: { location: back.href } });
  }

  function issue(account: string) {
    const grant = {
      account,
      access: `at-${random(24)}`,
      refresh: `rt-${random(24)}`,
      live: true,
      revoked: false,
    };
    grants.push(grant);
    const part = (json: object) => Buffer.from(JSON.stringify(json)).toString("base64url");
    return Response.json({
      id_token: [part({ alg: "none" }), part({ email: `${account}@files.example` }), ""].join("."),
      access_token: grant.access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: grant.refresh,
    });
  }

  async function token(request: Request) {
    const form = new URLSearchParams(await request.text());
    const field = (name: string) => form.get(name) ?? "";
    const seen: TokenRequest = {
      grant: field("grant_type"),
      at: performance.now(),
      ok: false,
      secret: field("client_secret") === secret,
      redirect: form.get("redirect_uri") ?? undefined,
    };
    tokens.push(seen);
    await held?.opened;
    if (down > 0) {
      down--;
      seen.refused = "HTTP 503";
      return new Response("<html><body>Service Unavailable</body></html>", {
        status: 503,
        headers: { "content-type": "text/html" },
      });
    }
    const answer = (() => {
      if (field("client_id") !== client || !seen.secret)
        return refuse("invalid_client", "The client is not known, or its secret is wrong.");
      if (seen.grant === "authorization_code") {
        const code = codes.get(field("code"));
        if (!code || code.used) return refuse("invalid_grant", "The code is not known, or was used already.");
        if (code.spoiled) return refuse("invalid_grant", "The code has run out.");
        if (code.redirect !== field("redirect_uri"))
          return refuse("invalid_grant", "The redirect address is not the link's.");
        const verifier = createHash("sha256").update(field("code_verifier")).digest("base64url");
        if (verifier !== code.challenge) return refuse("invalid_grant", "The code verifier does not match.");
        code.used = true;
        return issue(code.account);
      }
      if (seen.grant === "refresh_token") {
        const grant = grants.find((g) => g.refresh === field("refresh_token"));
        if (!grant || grant.revoked) return refuse("invalid_grant", "The refresh token was revoked.");
        grant.live = false;
        return issue(grant.account);
      }
      return refuse("unsupported_grant_type", `No grant ${seen.grant}.`);
    })();
    seen.ok = answer.status === 200;
    if (!seen.ok)
      seen.refused = ((await answer.clone().json()) as { error_description: string }).error_description;
    return answer;
  }

  const http = Bun.serve({
    hostname: reach.bind,
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (request.method === "GET" && url.pathname === "/authorize")
          return authorize(url, request.headers.get("x-signed-in-as"));
        if (request.method === "POST" && url.pathname === "/token") return await token(request);
        if (request.method === "GET" && url.pathname === "/page/")
          return existsSync(PAGE)
            ? new Response(readFileSync(PAGE), { headers: { "content-type": "text/html; charset=utf-8" } })
            : new Response("duck ships no page here", { status: 404 });
        return new Response("not found", { status: 404 });
      } catch (error) {
        trouble.add(error as Error);
        return new Response("the stand-in failed", { status: 500 });
      }
    },
  });
  const url = `http://${reach.host}:${http.port}`;

  return {
    url,
    client,
    /** The authorize address a setup names, with a fixed parameter of the service's own that duck must keep. */
    authorize: `${url}/authorize?prompt=consent`,
    token: `${url}/token`,
    /** Where the firm hosts duck's page. */
    page: `${url}/page/`,
    tokens,
    authorized,
    /** Every code the service issued, and every access and refresh token, so a test can look for them. */
    issued: () => [...codes.keys(), ...grants.flatMap((g) => [g.access, g.refresh])],
    /** The access tokens a plug of this service takes now: live and not revoked. */
    valid: () => grants.filter((g) => g.live && !g.revoked).map((g) => g.access),
    /** `account`'s newest grant, if it has one. */
    grantOf: (account: string) => grants.findLast((g) => g.account === account),
    /**
     * Follows `link` in a browser signed in to the service as `account`, which consents, and returns where
     * the service sent it: the page the link names, with the code and the state.
     */
    async follow(link: string, account: string) {
      const response = await fetch(link, { redirect: "manual", headers: { "x-signed-in-as": account } });
      const location = response.headers.get("location");
      if (response.status !== 302 || !location)
        throw new Error(`the service answered the link with ${response.status}: ${await response.text()}`);
      return location;
    },
    /** Makes `account`'s access tokens run out now, as time does, so a plug refuses them. */
    expire(account: string) {
      for (const g of grants) if (g.account === account) g.live = false;
    },
    /** Revokes `account`'s sign-in, as a person or their admin does: its tokens are refused and not renewed. */
    revoke(account: string) {
      for (const g of grants) if (g.account === account) g.revoked = true;
    },
    /** Makes every code issued so far run out, as a minute does at a service whose codes last that long. */
    spoil() {
      for (const c of codes.values()) c.spoiled = true;
    },
    /** Makes the token address answer the next `times` requests with a 503 and an HTML page, as a service that is down does. */
    fail(times = 1) {
      down = times;
    },
    /** Holds every token request until the function returned is called, as a slow service does. */
    hold() {
      let open = () => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      held = { opened, open };
      return () => {
        held = undefined;
        open();
      };
    },
    /** Forgets the requests seen and lets any held go, for the next step; what it issued stays good. */
    clear() {
      tokens.length = 0;
      authorized.length = 0;
      down = 0;
      held?.open();
      held = undefined;
    },
    stop: () => http.stop(true),
  };
}

export type Signin = ReturnType<typeof startSignin>;

/** The string duck's page shows the person to send their coworker: the link's state and the service's code. */
export const SIGNIN_STRING = /duck-sign-in:([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]+)/;

/** A stand-in element of the page: what a script sets on it and the click handlers it gives it. */
type Element = Record<string, unknown> & { clicks: (() => unknown)[] };

/**
 * Opens the page at `url` as a browser does, with enough of one to run its script: its own address, its
 * elements by id and the clipboard. Nothing the page could load from or send to anywhere is given it, and
 * what in it would load or send is listed. Returns what it shows, its controls and what pressing them copied.
 */
export async function openPage(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`the page at ${url} answered ${response.status}`);
  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const loads = [
    ...[...html.matchAll(/\b(?:src|href|action)\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1] as string),
    ...[...html.matchAll(/@import|url\(/gi)].map((m) => m[0]),
    ...scripts.flatMap(([, , code]) =>
      [
        ...(code ?? "").matchAll(/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|Image|import)\b/g),
      ].map((m) => m[1] as string),
    ),
  ];
  const elements = new Map<string, Element>();
  const element = (key: string): Element => {
    let e = elements.get(key);
    if (!e) {
      const made: Element = {
        textContent: "",
        value: "",
        hidden: false,
        disabled: false,
        clicks: [],
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener: (type: string, f: () => unknown) => {
          if (type === "click") made.clicks.push(f);
        },
        setAttribute() {},
        removeAttribute() {},
        focus() {},
        select() {},
      };
      elements.set(key, made);
      e = made;
    }
    return e;
  };
  const copied: string[] = [];
  const address = new URL(url);
  const location = {
    href: address.href,
    search: address.search,
    hash: address.hash,
    origin: address.origin,
    pathname: address.pathname,
  };
  const document = {
    getElementById: element,
    querySelector: element,
    body: element("body"),
    addEventListener: (_: string, f: () => unknown) => f(),
  };
  const navigator = { clipboard: { writeText: async (text: string) => void copied.push(text) } };
  const history = { replaceState() {}, pushState() {} };
  const window = { location, document, navigator, history };
  for (const [, attributes, code] of scripts) {
    if (/\bsrc\s*=/.test(attributes ?? "")) continue;
    new Function(
      "window",
      "document",
      "location",
      "navigator",
      "history",
      "fetch",
      "XMLHttpRequest",
      code ?? "",
    )(window, document, location, navigator, history, undefined, undefined);
  }
  const written = [...elements.values()].flatMap((e) => [String(e.textContent ?? ""), String(e.value ?? "")]);
  const words = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  const buttons = [...elements.values()].filter(
    (e) => e.clicks.length > 0 || typeof e.onclick === "function",
  );
  return {
    html,
    /** What the page shows: its own words and what its script wrote. */
    shows: [words, ...written].join(" "),
    /** The one string the page shows to send, if it shows one. */
    string: written.map((w) => SIGNIN_STRING.exec(w)?.[0]).find(Boolean),
    /** What in the page would load something or send something anywhere. */
    loads,
    buttons: buttons.length,
    /** Presses each button the page gives, as the person does, and returns what the clipboard was given. */
    async press() {
      for (const b of buttons) {
        for (const f of b.clicks) await f();
        if (typeof b.onclick === "function") await (b.onclick as () => unknown)();
      }
      return copied;
    },
  };
}
