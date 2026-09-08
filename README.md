# Review Platform Reputation Enricher MCP Server

[![Smithery](https://smithery.ai/badge/mambabuilt/mcp-review-platform-reputation-enricher)](https://smithery.ai/servers/mambabuilt/mcp-review-platform-reputation-enricher) [![Glama score](https://glama.ai/mcp/servers/mambalabsdev/mcp-review-platform-reputation-enricher/badges/score.svg)](https://glama.ai/mcp/servers/mambalabsdev/mcp-review-platform-reputation-enricher) [![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dcom.mambabuilt%252Fmcp-review-platform-reputation-enricher%26limit%3D1&query=%24.servers%5B0%5D._meta%5B%22io.modelcontextprotocol.registry%2Fofficial%22%5D.status&label=mcp%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.mambabuilt/mcp-review-platform-reputation-enricher&limit=1) [![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-review-platform-reputation-enricher)](https://www.npmjs.com/package/@mambalabsdev/mcp-review-platform-reputation-enricher) [![npm downloads](https://img.shields.io/npm/dm/@mambalabsdev/mcp-review-platform-reputation-enricher)](https://www.npmjs.com/package/@mambalabsdev/mcp-review-platform-reputation-enricher) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-review-platform-reputation-enricher)](https://github.com/mambalabsdev/mcp-review-platform-reputation-enricher/blob/main/LICENSE) [![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-blue)](https://mcpservers.org/servers/mambalabsdev/mcp-review-platform-reputation-enricher)

An MCP server that resolves a company domain to its Trustpilot rating, review count and claimed status. It wraps the Mamba Labs Trustpilot Reputation Enricher actor on Apify and returns a Clay-ready flat JSON row to any MCP client.

## What's Inside

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Example prompts](#example-prompts)
- [Inputs](#inputs)
- [Output](#output)
- [Example output](#example-output)
- [Features](#features)
- [Full actor documentation](#full-actor-documentation)
- [Mamba Labs GTM Suite](#mamba-labs-gtm-suite)
- [License](#license)

## What it does

Give it a company domain and it resolves that company's Trustpilot business unit and returns the TrustScore, review count, star score, the one to five star breakdown, claimed and verified status and categories, through Trustpilot's documented Business Units API. One flat row per company.

This route needs your own Trustpilot API key. Without one every row reports `skipped` rather than pretending to have looked. The tool keeps four kinds of empty apart: a refused request reports `blocked`, a domain with no business unit reports `not_found`, a value nobody could read reports `not_extractable`, and a source that was never queried reports `skipped`. G2, Capterra and Glassdoor ship as explicit skipped status columns, so the row shape does not change when a source is added.

All of the lookup runs on Apify. This package is a thin client that calls the actor and hands back the result unchanged.

## Quick start

You need Node.js 18 or newer and an Apify account with an API token.

Add this to your Claude Desktop config:

```json
{
  "mcpServers": {
    "mamba-review-platform-reputation-enricher": {
      "command": "npx",
      "args": ["-y", "@mambalabsdev/mcp-review-platform-reputation-enricher"],
      "env": {
        "APIFY_TOKEN": "your-apify-token"
      }
    }
  }
}
```

Get your token at https://console.apify.com/account/integrations, paste it in, and restart Claude Desktop. The `get_trustpilot_reputation` tool will be available.

You also need your own Trustpilot API key, free to create at developers.trustpilot.com. It is passed as a tool argument rather than an environment variable, so the model supplies it per call.

## Prerequisites

- Node.js 18 or newer
- An Apify account with an API token
- Your own Trustpilot API key, free at developers.trustpilot.com. The Business Units API is not open, so this is required.

## Example prompts

- "Get the Trustpilot rating for mattressonline.co.uk. Here is my Trustpilot key."
- "What is the star breakdown for this company on Trustpilot?"
- "Look up this domain's Trustpilot reputation and flag it only if it has at least 100 reviews."
- "Is this company's Trustpilot profile claimed and verified?"

## Inputs

- `company_domain` (optional): bare company domain, for example `stripe.com`. Trustpilot business units are keyed on the company website domain, so this is the correct and only lookup key.
- `company_name` (optional): carried through to the output row for joining. The lookup is keyed on the domain, so the name does not change which business unit is returned.
- `trustpilotApiKey` (optional in the schema, required in practice): your own Trustpilot API key, free to create at developers.trustpilot.com. Without a key the tool reports `skipped` rather than guessing.
- `minReviewCount` (optional): one of `none`, `10`, `50`, `100` or `500`. It sets `rating_is_meaningful` on the row. A 5.0 rating from two reviews and a 4.2 from nine hundred are not comparable numbers, and this is the column that says which one you are looking at. It never drops a row and never changes the rating returned.
- `includeCategories` (optional): when true (the default) the Trustpilot categories the business is listed under are returned. They are a cheap proxy for what a company actually sells, which is often not what its homepage says.
- `sources` (optional): which review sources to query. Version 1 serves `trustpilot` only. G2, Capterra and Glassdoor appear as columns and always report `skipped`, with the reason on the row. This setting exists so a saved configuration keeps working when a source is added.
- `skipCache` (optional): when false (the default) a successful lookup is cached for seven days and reused. Set true to force a fresh fetch.

## Output

The tool returns the actor's flat JSON row for the company, with 31 snake_case fields and no nested objects. `trustpilot_status` is the field to read before any rating, `trustpilot_route` and `trustpilot_id_source` say how the business unit was resolved, and `rating_is_meaningful` reflects the review count threshold you set. See the Apify Store page for the full output schema.

## Example output

```json
{
  "degraded": false,
  "degradation_reason": null,
  "company_domain": "mattressonline.co.uk",
  "company_name": "Mattress Online",
  "trustpilot_business_id": "4992d8e10000640005041a9a",
  "trustpilot_url": "https://www.trustpilot.com/review/www.mattressonline.co.uk",
  "trustpilot_name": "MattressOnline.co.uk",
  "trustpilot_rating": 4.8,
  "trustpilot_review_count": 72332,
  "trustpilot_stars": 5,
  "trustpilot_one_star": 1618,
  "trustpilot_two_stars": 768,
  "trustpilot_three_stars": 1485,
  "trustpilot_four_stars": 5850,
  "trustpilot_five_stars": 62611,
  "trustpilot_country_code": "GB",
  "trustpilot_route": "widget",
  "trustpilot_id_source": "homepage_embed",
  "trustpilot_claimed_status": "not_extractable",
  "trustpilot_is_claimed": null,
  "rating_is_meaningful": true,
  "trustpilot_status": "ok",
  "g2_status": "skipped",
  "capterra_status": "skipped",
  "glassdoor_status": "skipped",
  "coverage": 1,
  "fetch_status": "ok",
  "run_date": "2026-08-23T06:39:38.824Z"
}
```

## Features

- TrustScore, star score and total review count
- The full one to five star breakdown, not just the average
- Claimed and verified status, plus Trustpilot categories
- Four kinds of empty, each with its own status, so a refusal is never a zero
- G2, Capterra and Glassdoor ship as explicit skipped columns
- 31 flat snake_case fields, one row per company

## Full actor documentation

This server is a thin client and holds no lookup logic. For the complete input and output reference, pricing, and run history, see the Apify Store page:

https://apify.com/mambalabs/review-platform-reputation-enricher

---

## Mamba Labs GTM Suite

This server is one of the Mamba Labs GTM Suite MCP servers. Every actor in the suite takes a domain or a company and returns one flat row, so they stack in the same Clay table without reshaping anything. The actor behind this server is the Trustpilot Reputation Enricher, immutable Apify actor ID `3lIqfCt61j4hqE1xz`.

> Built by [Mamba Labs](https://github.com/mambalabsdev) | [npm](https://www.npmjs.com/org/mambalabsdev) | [Apify Store](https://apify.com/mambalabs)

## License

MIT

Built by Mamba Labs. https://apify.com/mambalabs
