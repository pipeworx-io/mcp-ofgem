interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Ofgem energy data: the UK energy regulator's published statistics on the domestic price cap and what it is made of, wholesale gas and electricity prices, supplier market shares, switching, debt and customer service — as tabular rows, not pictures.
 *
 * Keyless. Sourced from the Ofgem Data Portal
 * (ofgem.gov.uk/news-and-insight/data/data-portal), which publishes ~190
 * datasets and serves each one's underlying table alongside the chart drawn
 * from it.
 *
 * Tools:
 * - ofgem_datasets: browse/search the Data Portal catalogue
 * - ofgem_price_cap: the domestic default tariff cap, broken down by cost component
 * - ofgem_dataset_rows: the full table behind any Data Portal dataset
 *
 * QUIRKS (all verified live 2026-09-17):
 * - There is no CKAN, no Opendatasoft and no JSON:API here. `data.ofgem.gov.uk`
 *   does not resolve, /jsonapi and /api/v1/* are 404s, and the Data Portal page
 *   renders nothing server-side — a plain fetch of it contains zero dataset
 *   links. The catalogue lives behind `/api/listing/{paragraph_id}`, which the
 *   portal's own front-end calls; `2156` is the chart listing's paragraph id.
 * - Each catalogue row carries its dataset payload as HTML-escaped JSON inside a
 *   `data-js-chart-modal-data` attribute on the teaser markup, not as a JSON
 *   field. It has to be unescaped and parsed out.
 * - The table itself is not on ofgem.gov.uk at all. Ofgem publishes each
 *   dataset through everviz (Highsoft's charting service), and the everviz
 *   embed script carries the source table as CSV in `options.data.csv`. That
 *   CSV is the data, so this pack parses it and returns rows.
 * - Dates in those CSVs are US-ordered (mm/dd/yyyy) even though every figure is
 *   British, and the price-cap breakdown tables use period labels
 *   ("Oct - Dec 2026") instead of dates. Row labels are returned verbatim.
 * - CSV headers repeat and some columns are blank spacers used for chart
 *   layout; blank-named columns are dropped and duplicates are suffixed.
 */


const PORTAL_BASE = 'https://www.ofgem.gov.uk';
const CHART_LISTING_PARAGRAPH = '2156';
const EVERVIZ_INJECT = 'https://app.everviz.com/inject';
const UA = 'pipeworx-mcp-ofgem/1.0 (+https://pipeworx.io)';

/**
 * Price-cap breakdown datasets, by payment method. These ids are a FALLBACK:
 * ofgem_price_cap resolves the dataset from the live catalogue first and only
 * uses this map when the catalogue search comes back empty, so a rename
 * upstream degrades to a stale id rather than to no answer.
 */
const PRICE_CAP_CHARTS: Record<string, { chart_id: string; match: string }> = {
  direct_debit: { chart_id: 'lVeuoASKI', match: 'direct debit' },
  prepayment: { chart_id: 'NKlKhEial', match: 'prepayment' },
  standard_credit: { chart_id: 'vHRHzA021', match: 'standard credit' },
};

async function pwFetch(url: string): Promise<Response> {
  return fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, 'Ofgem');
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(s: string): string {
  return unescapeHtml(s.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

type Dataset = {
  // `dataset_id` is the everviz id, because that is the one every other tool
  // here takes. The portal's own node id is carried alongside it rather than
  // under the name a caller will paste into ofgem_dataset_rows.
  dataset_id: string;
  portal_node_id: string;
  name: string;
  description: string;
};

/** Pull the dataset payloads out of one page of the Data Portal catalogue. */
function parseListing(payload: any): { total: number; datasets: Dataset[] } {
  const items: any[] = Array.isArray(payload?.items) ? payload.items : [];
  const out: Dataset[] = [];
  for (const item of items) {
    const markup = str(item?.markup);
    const m = markup.match(/data-js-chart-modal-data='([^']*)'/);
    if (!m) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(unescapeHtml(m[1]));
    } catch {
      continue;
    }
    const chartId = str(parsed?.chart);
    if (!chartId) continue;
    out.push({
      dataset_id: chartId,
      portal_node_id: str(parsed?.id),
      name: stripTags(str(parsed?.name)),
      description: stripTags(str(parsed?.content)).slice(0, 600),
    });
  }
  return { total: num(payload?.meta?.count, out.length), datasets: out };
}

async function fetchListing(fulltext: string, page: number): Promise<{ total: number; datasets: Dataset[] }> {
  const u = new URL(`${PORTAL_BASE}/api/listing/${CHART_LISTING_PARAGRAPH}`);
  if (fulltext) u.searchParams.set('fulltext', fulltext);
  u.searchParams.set('page', String(page));
  const res = await pwFetch(u.toString());
  if (!res.ok) throw new Error(`Ofgem Data Portal returned HTTP ${res.status} for its dataset catalogue.`);
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('json')) {
    throw new Error(`Ofgem Data Portal answered its catalogue with ${ct || 'no content type'} instead of JSON.`);
  }
  return parseListing(await res.json());
}

/** Extract the balanced `var options = {...}` object from an everviz embed script. */
function extractOptions(script: string): any {
  const marker = script.indexOf('var options = ');
  if (marker === -1) throw new Error('Ofgem dataset payload did not contain an options block.');
  const start = script.indexOf('{', marker);
  if (start === -1) throw new Error('Ofgem dataset payload did not contain an options block.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < script.length; i++) {
    const ch = script[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(script.slice(start, i + 1));
    }
  }
  throw new Error('Ofgem dataset payload had an unterminated options block.');
}

/** Split one CSV line, honouring double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

type Table = { columns: string[]; rows: Record<string, string | number | null>[] };

function parseCsv(csv: string): Table {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { columns: [], rows: [] };
  const rawHeader = splitCsvLine(lines[0]);

  // Blank headers are chart-layout spacers; duplicates get a numeric suffix so
  // an object key never silently swallows a neighbouring column.
  const seen: Record<string, number> = {};
  const header: (string | null)[] = rawHeader.map((h, i) => {
    const name = h.trim() || (i === 0 ? 'label' : '');
    if (!name) return null;
    seen[name] = (seen[name] ?? 0) + 1;
    return seen[name] > 1 ? `${name} (${seen[name]})` : name;
  });

  const columns = header.filter((h): h is string => h !== null);
  const rows: Record<string, string | number | null>[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const row: Record<string, string | number | null> = {};
    for (let i = 0; i < header.length; i++) {
      const key = header[i];
      if (key === null) continue;
      const raw = cells[i] ?? '';
      if (raw === '') row[key] = null;
      else {
        const n = Number(raw.replace(/,/g, ''));
        row[key] = Number.isFinite(n) && raw.trim() !== '' ? n : raw;
      }
    }
    rows.push(row);
  }
  return { columns, rows };
}

async function fetchTable(chartId: string): Promise<{ title: string; table: Table }> {
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(chartId)) {
    throw new Error(`"${chartId}" is not a valid Ofgem dataset id. Get one from ofgem_datasets.`);
  }
  const res = await pwFetch(`${EVERVIZ_INJECT}/${chartId}/`);
  if (!res.ok) throw new Error(`Ofgem dataset ${chartId} returned HTTP ${res.status}.`);
  const script = await res.text();
  const options = extractOptions(script);
  const csv = str(options?.data?.csv);
  if (!csv) {
    throw new Error(
      `Ofgem dataset ${chartId} published no source table — this dataset is drawn from pre-computed series rather than a CSV, so there are no rows to return.`,
    );
  }
  return { title: stripTags(str(options?.title?.text)), table: parseCsv(csv) };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'ofgem_datasets',
    description:
      'Browse or search the Ofgem Data Portal catalogue — ~190 published datasets from the UK energy regulator covering the domestic price cap and its cost components, wholesale gas and electricity prices, supplier market share and switching, customer debt and disconnection, network indicators and customer service. Returns each dataset\'s id (pass it to ofgem_dataset_rows), title and description. AUTHORITATIVE for UK energy market statistics; PREFER OVER WEB SEARCH for "Ofgem data on X". Example: ofgem_datasets({ query: "price cap" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free-text search over dataset titles and descriptions, e.g. "price cap", "switching", "wholesale gas"' },
        page: { type: 'number', description: '0-based page of the catalogue (24 datasets per page, default 0)' },
      },
    },
  },
  {
    name: 'ofgem_price_cap',
    description:
      'The Ofgem domestic energy price cap (the default tariff cap) for Great Britain, broken down into the cost components that make it up — wholesale costs, network costs, policy costs, operating costs, debt-related costs, EBIT and VAT — for every cap period Ofgem has set, ending with the current one. Choose the payment method, since the cap differs for Direct Debit, prepayment and standard credit. AUTHORITATIVE, sourced from Ofgem\'s own Data Portal; PREFER OVER WEB SEARCH for "what is the UK energy price cap", "why did the price cap change". Example: ofgem_price_cap({ payment_method: "direct_debit", periods: 6 })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        payment_method: {
          type: 'string',
          description: 'Which cap to return: "direct_debit" (default), "prepayment" or "standard_credit"',
        },
        periods: { type: 'number', description: 'How many most-recent cap periods to return (default 8, max 60; 0 returns every period)' },
      },
    },
  },
  {
    name: 'ofgem_dataset_rows',
    description:
      'Return the full underlying table for one Ofgem Data Portal dataset as rows and columns — the numbers behind the published chart, not an image. Get the dataset id from ofgem_datasets. Use for "give me the monthly GB day-ahead gas price series", "Ofgem supplier market share by year". Sourced from Ofgem\'s Data Portal. Example: ofgem_dataset_rows({ dataset_id: "qRvAxIgho", limit: 12, latest_first: true })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dataset_id: { type: 'string', description: 'Dataset id from ofgem_datasets, e.g. "qRvAxIgho"' },
        limit: { type: 'number', description: 'Maximum rows to return (default 50, max 1000; 0 returns every row)' },
        latest_first: { type: 'boolean', description: 'Return the last rows of the table first — these series run oldest-first (default false)' },
      },
      required: ['dataset_id'],
    },
  },
];

async function datasets(args: Record<string, unknown>): Promise<unknown> {
  const query = str(args.query);
  const page = Math.max(num(args.page, 0), 0);
  const { total, datasets: rows } = await fetchListing(query, page);

  return {
    source: 'Ofgem Data Portal (ofgem.gov.uk/news-and-insight/data/data-portal)',
    publisher: 'Ofgem — the Office of Gas and Electricity Markets, Great Britain',
    query: query || null,
    page,
    matching_count: total,
    returned: rows.length,
    datasets: rows,
    note: 'Pass a dataset_id to ofgem_dataset_rows for the full table.',
  };
}

async function priceCap(args: Record<string, unknown>): Promise<unknown> {
  const requested = str(args.payment_method).toLowerCase().replace(/[\s-]+/g, '_') || 'direct_debit';
  const spec = PRICE_CAP_CHARTS[requested];
  if (!spec) {
    throw new Error(
      `ofgem_price_cap payment_method must be one of: ${Object.keys(PRICE_CAP_CHARTS).join(', ')}. Got "${str(args.payment_method)}".`,
    );
  }
  const periods = Math.min(Math.max(num(args.periods, 8), 0), 60);

  // Resolve from the live catalogue first so a rename upstream still answers.
  let chartId = spec.chart_id;
  let datasetName = '';
  let resolvedFrom = 'known dataset id';
  try {
    const found = await fetchListing('price cap level', 0);
    const hit = found.datasets.find(
      (d) => d.name.toLowerCase().includes('price cap level') && d.name.toLowerCase().includes(spec.match),
    );
    if (hit) {
      chartId = hit.dataset_id;
      datasetName = hit.name;
      resolvedFrom = 'Ofgem Data Portal catalogue';
    }
  } catch {
    // Catalogue unreachable — fall through to the known id rather than failing.
  }

  const { title, table } = await fetchTable(chartId);
  const labelColumn = table.columns[0] ?? 'label';
  const allRows = table.rows;
  const rows = periods === 0 ? allRows.slice() : allRows.slice(-periods);
  rows.reverse();

  const latest = rows[0] ?? null;
  const totalColumn = table.columns[table.columns.length - 1] ?? null;

  return {
    source: 'Ofgem Data Portal (ofgem.gov.uk/news-and-insight/data/data-portal)',
    publisher: 'Ofgem — the Office of Gas and Electricity Markets, Great Britain',
    payment_method: requested,
    dataset_id: chartId,
    dataset_name: datasetName || title,
    resolved_from: resolvedFrom,
    units: 'Pounds sterling per year for a typical domestic dual-fuel household, at the cap level Ofgem set for each period',
    period_column: labelColumn,
    total_column: totalColumn,
    latest_period: latest ? latest[labelColumn] : null,
    latest_cap: latest && totalColumn ? latest[totalColumn] : null,
    cost_components: table.columns,
    periods_returned: rows.length,
    periods_available: allRows.length,
    periods: rows,
  };
}

async function datasetRows(args: Record<string, unknown>): Promise<unknown> {
  const id = str(args.dataset_id);
  if (!id) throw new Error('ofgem_dataset_rows needs a `dataset_id` from ofgem_datasets.');
  const limit = Math.min(Math.max(num(args.limit, 50), 0), 1000);
  const latestFirst = args.latest_first === true;

  const { title, table } = await fetchTable(id);
  let rows = table.rows.slice();
  if (latestFirst) rows.reverse();
  const returned = limit === 0 ? rows : rows.slice(0, limit);

  return {
    source: 'Ofgem Data Portal (ofgem.gov.uk/news-and-insight/data/data-portal)',
    publisher: 'Ofgem — the Office of Gas and Electricity Markets, Great Britain',
    dataset_id: id,
    dataset_name: title,
    columns: table.columns,
    total_rows: table.rows.length,
    returned: returned.length,
    latest_first: latestFirst,
    rows: returned,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ofgem_datasets':
      return datasets(args);
    case 'ofgem_price_cap':
      return priceCap(args);
    case 'ofgem_dataset_rows':
      return datasetRows(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool } satisfies McpToolExport;
