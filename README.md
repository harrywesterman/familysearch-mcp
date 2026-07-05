# FamilySearch MCP Server

A Model Context Protocol (MCP) server for FamilySearch. Lets AI tools like Codex search the Family Tree, view person details, explore ancestors and descendants, and search historical records.

## How it works

FamilySearch does not approve direct API access for most personal projects. This MCP reuses your **browser session cookies** from [familysearch.org](https://www.familysearch.org) and calls the same internal `/service/` endpoints the website uses.

| Feature | Endpoint |
|---|---|
| Person details | `/service/tree/tree-data/v8/person/{id}/card` |
| Family members | `/service/tree/tree-data/r9/family-members/person/{id}` |
| Ancestors | `/service/tree/tree-data/r9/portrait-pedigree/{id}` |
| Tree search | `/service/search/tree/v2/personas` |
| Record search | `/service/search/hr/v2/personas` |

## Prerequisites

- Node.js 16+ and npm
- [Brave browser](https://brave.com/download/) (used for login — Playwright's bundled Chromium is blocked by FamilySearch)
- A free FamilySearch account

## Quick start

```bash
npm install
npm run build
npm run login
```

`npm run login` opens Brave with a dedicated profile. Sign in when the browser opens; your session is saved to `~/.familysearch-mcp/config.json`.

Then configure the MCP in Codex and start using the tools.

## Codex setup

The server is registered globally in `~/.codex/config.toml`. If you need to add it manually:

```toml
[mcp_servers.familysearch]
command = "/Users/jonathanreiss/.volta/bin/node"
args = ["/path/to/familysearch-mcp/build/index.js"]
```

Or from this repo:

```bash
codex mcp add familysearch -- node build/index.js
```

Run `npm run build` first. In Codex, use `/mcp` to confirm `familysearch` is connected.

This repo also includes `.codex/config.toml` for project-scoped config when the directory is trusted.

## Authentication

### Option 1: Browser login (recommended)

```bash
npm run login
```

Opens Brave (not headless Chromium) to avoid FamilySearch bot detection. Or ask your AI tool: `Log in to FamilySearch using login-with-browser`

### Option 2: Copy cookies manually

1. Log in at [familysearch.org](https://www.familysearch.org)
2. In DevTools → Console, run: `copy(document.cookie)`
3. Use the `set-session-cookie` tool with the copied string

The full cookie string is required — bot protection cookies like `reese84` and `incap_ses_*` must be included, not just `fssessionid`.

## MCP Tools

### Authentication

- `login-with-browser` — Open browser, log in, save session
- `set-session-cookie` — Paste cookies from your browser
- `get-current-user` — View your account info

### Family Tree

- `search-persons` — Search individuals in the Family Tree
- `get-person` — View a person by ID
- `get-ancestors` — View ancestors (up to 8 generations)
- `get-descendants` — View descendants (up to 3 generations)

### Historical Records

- `search-records` — Search historical record collections

## Example queries

```
Search for persons with name: "John Smith" birthPlace: "New York"
```

```
Get person with personId: G2KQ-JTH
```

```
Get ancestors for personId: G2KQ-JTH with generations: 4
```

## Security

Your session cookies are stored locally in `~/.familysearch-mcp/config.json`. They grant the same access as your browser session — never share this file. Sessions expire after inactivity; run `npm run login` again when tools return auth errors.

## License

ISC
