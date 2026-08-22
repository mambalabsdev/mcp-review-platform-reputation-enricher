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

const APIFY_TOKEN = process.env.APIFY_TOKEN;

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

// actorPath is the actor's IMMUTABLE Apify actor id, not its slug, so a Store
// rename never breaks these calls.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  // memory=256 is deliberate and matches the actor's declared
  // defaultRunOptions.memoryMbytes. run-sync-get-dataset-items runs at 2048 MB
  // unless told otherwise, and `apify-actor-start` bills once per GB with a
  // minimum of one, so leaving the default in place would charge the caller
  // more start events per run than the actor asks for. Keep this in step with
  // the actor's defaultRunOptions.
  const url = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?timeout=300&memory=256`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }

    let message: string;
    switch (response.status) {
      case 401:
        message = "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
        break;
      case 402:
        message = "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
        break;
      case 408:
        message = `The ${actorLabel} run timed out after 300 seconds. Try again, or run the actor on Apify directly for longer jobs.`;
        break;
      default:
        message = `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
    return { isError: true, content: [{ type: "text", text: message }] };
  }

  // A 2xx normally carries the dataset array. Pass actor output through
  // unchanged: the wrapper must never reinterpret a status field, because
  // not_extractable, blocked and not_found are different answers and collapsing
  // them is exactly the defect the actor was built to avoid.
  const items = await response.json();
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
      "Resolve a company domain to its Trustpilot business unit and return the TrustScore, review count, star score, claimed and verified status and categories, through Trustpilot's documented Business Units API. Returns one flat Clay ready row. Requires the CALLER's own Trustpilot API key; without one every row reports skipped rather than pretending to have looked. A refused request reports blocked and a domain with no business unit reports not_found, and those two are never conflated. G2, Capterra and Glassdoor ship as skipped status columns so the row shape does not change when a source is added. Read only; requires an APIFY_TOKEN and consumes Apify credits per call.",
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
        .describe("Bare company domain, for example stripe.com. Trustpilot business units are keyed on the company website domain, so this is the correct and only lookup key."),
      company_name: z.string()
        .optional()
        .describe("Optional. Carried through to the output row for joining. The Trustpilot lookup is keyed on the domain, so the name does not change which business unit is returned."),
      trustpilotApiKey: z.string()
        .optional()
        .describe("YOUR OWN Trustpilot API key, free to create at developers.trustpilot.com. REQUIRED: the Business Units API is not open, so without a key this actor reports skipped rather than guessing. Marked secret, so the value never renders on this page."),
      minReviewCount: z.enum(["none", "10", "50", "100", "500"])
        .optional()
        .describe("Sets rating_is_meaningful on the row. A 5.0 rating from two reviews and a 4.2 from nine hundred are not comparable numbers, and this is the column that says which one you are looking at. It never drops a row and never changes the rating returned. Sent as a string for Clay compatibility."),
      includeCategories: z.boolean()
        .optional()
        .describe("When \"true\" (default) the Trustpilot categories the business is listed under are returned. They are a useful cheap proxy for what a company actually sells, which is often not what its homepage says. Sent as a string for Clay compatibility."),
      sources: z.enum(["trustpilot"])
        .optional()
        .describe("Which review sources to query. v1 serves Trustpilot only. G2, Capterra and Glassdoor appear as columns and always report skipped, with the reason on the row, because all three refused every documented route and none publishes an API we can use as documented. This setting exists so a saved configuration keeps working when a source is added. Sent as a string for Clay compatibility."),
      skipCache: z.boolean()
        .optional()
        .describe("When \"false\" (default) a successful lookup is cached for seven days and reused, which costs you nothing on a repeated run. Set \"true\" to force a fresh fetch. Sent as a string for Clay compatibility."),
    },
  },
  async ({ company_domain, company_name, trustpilotApiKey, minReviewCount, includeCategories, sources, skipCache }) => {
    return runActor(
      "3lIqfCt61j4hqE1xz",
      "Trustpilot Reputation Enricher",
      compact({
        company_domain,
        company_name,
        trustpilotApiKey,
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
