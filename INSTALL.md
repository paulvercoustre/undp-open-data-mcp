# Installing the UNDP Open Data connector

## For most people: the one-file install (Claude Desktop)

1. Download **`undp-open-data.mcpb`**.
2. Open Claude Desktop → **Settings → Extensions**.
3. Drag the file onto the window (or use *Install extension*).
4. Restart Claude Desktop.

No Node.js install, no terminal, no config files — Claude ships its own Node runtime.
To update, install the newer `.mcpb` over the top and restart.

### Check it worked

Ask: **"Which countries received the most UNDP funding in 2023?"**

You should get Argentina, Iraq and Zimbabwe at the top. If nothing happens, the
extension is not loaded — confirm it is listed and enabled under Settings → Extensions,
and that you restarted the app.

## For other AI tools (Cursor, VS Code, Gemini CLI, ChatGPT desktop, Zed …)

The server is a standard MCP server and is not tied to Claude — but `.mcpb` is a
Claude Desktop format, so elsewhere point the client at the built server directly:

```json
{
  "mcpServers": {
    "undp-open-data": {
      "command": "node",
      "args": ["/absolute/path/to/undp_db_mcp/dist/index.js"]
    }
  }
}
```

That block is what nearly every MCP client expects; only the file it goes in differs.
Build it first with `npm install && npm run build`.

For raw model APIs with no MCP support (OpenAI `chat.completions`, Gemini
`generateContent`), the tool schemas are plain JSON Schema and map directly onto
function-calling definitions — see the design notes in [README.md](README.md).

## What to tell colleagues it does

It answers questions about **UNDP funding that has already been committed**: which
donors fund which themes and countries, how much, alongside whom, and what the money
was classified as.

It is **not** a feed of open calls, tenders or upcoming opportunities — that data is not
in the UNDP API. For business development it is useful as *donor intelligence*
(who funds work like ours, and where), not as a pipeline of live bids.

Other things worth knowing before relying on a number:

- **The current year is incomplete.** Budgets are still being booked, so this year's
  totals are partial and will keep moving. Compare like with like.
- **`budget` is allocated, `expenditure` is spent.** They are different questions.
- **All figures are nominal USD** with no inflation adjustment, so multi-year
  comparisons overstate real growth.
- **Some "donor countries" are not countries** — global funds such as GFATM and UNDP
  itself appear in that field.
- **An empty result is not proof of absence.** Some UNDP API filters return nothing
  even where data exists; the connector flags the known cases.

## Building the extension yourself

```bash
npm install
./scripts/build-mcpb.sh
```

Produces `undp-open-data.mcpb` (~240 KB). The server is bundled into a single file with
esbuild rather than shipping `node_modules`, which would be 26 MB across 3,630 files.
