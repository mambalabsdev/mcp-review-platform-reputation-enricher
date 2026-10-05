#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor at all.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// The actor types its switches as strings ("true"/"false") for Clay
// compatibility, because Clay sends every input as a string and a boolean typed
// field silently receives "false" and reads it as truthy. The model gets a real
// boolean and the actor gets the string it validates.
function boolToString(v: boolean | undefined): string | undefined {
  return v === undefined ? undefined : v ? "true" : "false";
}

// The actor run's own timeout, in seconds, unchanged from the earlier run-sync
// call. The run ends TIMED-OUT at this limit and the caller is told so, with
// the run id, instead of a 408 while the run carries on.
const ACTOR_RUN_TIMEOUT_SECS = 300;

// How long this wrapper waits for that run, in milliseconds. The actor's own
// timeout plus two minutes, so the run's own TIMED-OUT status is what the
// caller sees rather than the wrapper giving up first and reporting nothing.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = 3000;

// memory=256 matches the actor's declared defaultRunOptions.memoryMbytes.
// `apify-actor-start` bills once per GB with a minimum of one, so an explicit
// value keeps the caller from paying for more memory than the actor asks for.
// Keep this in step with the actor's defaultRunOptions.
const RUN_QUERY = `timeout=${ACTOR_RUN_TIMEOUT_SECS}&memory=256`;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames).
//
// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoints carry a platform
// ceiling of 300 seconds on the HTTP wait itself and answer 408 past it, so a
// long run reads as a timeout even though the actor goes on and bills. Starting
// the run, polling it to a terminal status and then reading the dataset waits
// as long as the actor needs.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities.
//
// The wrapper never reinterprets a row's status field: not_extractable,
// blocked and not_found are different answers and are passed through unchanged.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?${RUN_QUERY}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success.
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}). Read it at https://console.apify.com/actors/runs/${runId}` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message ? `${asObj.error.message}` : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-review-platform-reputation-enricher",
  version: pkg.version,
});

// Trustpilot Reputation Enricher (immutable actor ID 3lIqfCt61j4hqE1xz)
server.registerTool(
  "get_trustpilot_reputation",
  {
    title: "Get Trustpilot Reputation",
    description:
      "Return a company's Trustpilot rating, review count, star score, and one to five star breakdown as one flat Clay ready row. Trustpilot only: G2, Capterra, and Glassdoor ship as skipped status columns so the row shape stays fixed, and they are never fetched. By default it reads Trustpilot's public TrustBox data endpoint, which Trustpilot's robots.txt allows, and needs no Trustpilot API key. Pass trustpilotBusinessUnitId whenever you have it: with the id the lookup always resolves, while a domain alone resolves only when the company's own site embeds a Trustpilot widget. A row's trustpilot_business_id can be fed back as the id on a later call. Set publicPageAccess to unblocker to read the public company page through Apify Unblocker instead, which resolves a domain with no id and adds categories and claimed status, at a higher event price and against Trustpilot's robots.txt, so it is the caller's choice. A refused request reports blocked and a domain with no business unit reports not_found, and those two are never conflated. Do not use it for review text: it returns the aggregate, not review rows. Read only; requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
      title: "Get Trustpilot Reputation",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      company_domain: z.string()
        .optional()
        .describe("Bare company domain, for example monzo.com. Used to look for a Trustpilot business unit id in the company's own widget embed. Supplying trustpilotBusinessUnitId instead skips this step and always resolves."),
      company_name: z.string()
        .optional()
        .describe("Optional. Carried through to the output row for joining. The lookup is keyed on the business unit id, so the name never changes which business is returned."),
      trustpilotBusinessUnitId: z.string()
        .optional()
        .describe("The 24 character Trustpilot business unit id, for example 57da77be0000ff000594bcdb. The fastest and most reliable input: supplied here it always resolves. Find it in the page source of any site running a Trustpilot widget, as data-businessunit-id, or reuse trustpilot_business_id from an earlier row. Leave it empty and the actor looks for it on the company's own site."),
      publicPageAccess: z.enum(["off", "unblocker"])
        .optional()
        .describe("Leave at \"off\" (default) to read only Trustpilot's public TrustBox data endpoint, which Trustpilot's robots.txt allows. Set \"unblocker\" to read Trustpilot's public company pages through Apify Unblocker, which resolves any domain with no business unit id and also returns categories, claimed status, and verification. Trustpilot's robots.txt disallows those pages to automated agents, so this is the caller's call, and it spends Unblocker units from the caller's Apify account. A row resolved this way charges public-page-profile-returned instead of reputation-resolved, never both."),
      minReviewCount: z.enum(["none", "10", "50", "100", "500"])
        .optional()
        .describe("Sets rating_is_meaningful on the row. A 5.0 rating from two reviews and a 4.2 from nine hundred are not comparable numbers, and this is the column that says which one you are looking at. It never drops a row and never changes the rating returned. Sent as a string for Clay compatibility."),
      includeCategories: z.boolean()
        .optional()
        .describe("Has no effect on the default route: Trustpilot publishes categories only on its public company page, so trustpilot_categories is null unless publicPageAccess is unblocker. Kept so saved configurations keep working. Sent as a string for Clay compatibility."),
      sources: z.enum(["trustpilot"])
        .optional()
        .describe("Which review sources to query. This version serves Trustpilot only. G2, Capterra, and Glassdoor appear as columns and always report skipped, with the reason on the row. This setting exists so a saved configuration keeps working when a source is added. Sent as a string for Clay compatibility."),
      skipCache: z.boolean()
        .optional()
        .describe("When \"false\" (default) a successful lookup is cached for seven days and reused, which costs nothing on a repeated run. Set \"true\" to force a fresh fetch. Sent as a string for Clay compatibility."),
    },
  },
  async ({ company_domain, company_name, trustpilotBusinessUnitId, publicPageAccess, minReviewCount, includeCategories, sources, skipCache }) => {
    return runActor(
      "3lIqfCt61j4hqE1xz",
      "Trustpilot Reputation Enricher",
      compact({
        company_domain,
        company_name,
        trustpilotBusinessUnitId,
        publicPageAccess,
        minReviewCount,
        includeCategories: boolToString(includeCategories),
        sources,
        skipCache: boolToString(skipCache),
      }),
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
