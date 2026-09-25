# @pipeworx/ofgem

Ofgem energy data — the UK energy regulator's published statistics on the
domestic price cap and what it is made of, wholesale gas and electricity prices,
supplier market shares, switching, debt and customer service, returned as
tabular rows rather than pictures.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

- `ofgem_datasets(query?, page?)` — the Data Portal catalogue (~190 datasets).
  Returns `dataset_id`, the id every other tool here takes.
- `ofgem_price_cap(payment_method?, periods?)` — the default tariff cap by
  period, broken into wholesale / network / policy / operating / debt / EBIT /
  VAT components, for Direct Debit, prepayment or standard credit.
- `ofgem_dataset_rows(dataset_id, limit?, latest_first?)` — the full source
  table behind any Data Portal dataset.

## Auth

Keyless.

## Data sources

- <https://www.ofgem.gov.uk/api/listing/2156> — the Data Portal chart catalogue.
- <https://app.everviz.com/inject/{dataset_id}/> — the source table for one dataset.

Things worth knowing:

- **There is no CKAN, no Opendatasoft and no JSON:API.** `data.ofgem.gov.uk`
  does not resolve at all (no A record; it has MX records only). `/jsonapi`,
  `/api/v1/datasets` and `/api/search` are 404s. The Data Portal page renders
  nothing server-side — a plain fetch of
  `/news-and-insight/data/data-portal/all-available-charts` contains **zero**
  dataset links, so scraping the HTML returns an empty list, not an error.
- **The catalogue is `/api/listing/{paragraph_id}`**, the endpoint the portal's
  own front end calls (found in
  `themes/custom/numiko/dist/filter-listing-legacy-*.js`). `2156` is the chart
  listing's paragraph id. It takes `fulltext=` and `page=` (0-based, 24 per page)
  and reports the match count in `meta.count`.
- **Each catalogue row carries its dataset payload as HTML-escaped JSON** inside
  a `data-js-chart-modal-data` attribute on the row's teaser markup, not as a
  JSON field. It has to be unescaped and parsed out.
- **The table is not on ofgem.gov.uk.** Ofgem publishes each dataset through
  everviz (Highsoft), and the everviz embed script carries the source table as
  CSV in `options.data.csv`. That CSV is the data; this pack parses it.
- **Dates in those CSVs are US-ordered (mm/dd/yyyy)** even though every figure is
  British, and the price-cap breakdown tables use period labels ("Oct - Dec
  2026") rather than dates. Row labels are returned verbatim.
- **CSV headers repeat and some are blank spacers** used for chart layout.
  Blank-named columns are dropped; duplicate names get a `(2)` suffix so one
  column never silently swallows its neighbour.
- `ofgem_price_cap` resolves its dataset from the live catalogue first and only
  falls back to the known everviz ids, so an upstream rename degrades to a stale
  id rather than to no answer.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ofgem": {
      "url": "https://gateway.pipeworx.io/ofgem/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ofgem/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ofgem_datasets \
  -H 'Content-Type: application/json' \
  -d '{"query":"price cap"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ofgem_datasets`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "ofgem": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ofgem"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-ofgem
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ofgem data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
