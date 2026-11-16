# git-forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/jakiww/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/jakiww/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, single-process, GitHub-compatible git forge — built for the
[make.fun bounty](https://make.fun/bounty/github-core-clone-01). One Node 22
process serves git smart HTTP, the REST v3 API, GraphQL and MCP from its own
in-memory store. No dependencies, no git binary, no database, no internet at
runtime: Node's standard library only.

Local conformance (kit's sealed suite, run against this code): **120/120
checks pass** (git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol
5/5, GraphQL 20/20, MCP 15/15) and **175/200 performance points** — an
estimated total of **~975/1000** against the reference forge's ~900.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
`node:http`, `node:crypto`, `node:zlib` and its own modules only.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in
`MAKEFUN_ENV_URL`.

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one.
   Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with
   `{"port": <the port you bound>}`, as JSON.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers `{"done":false}`
   while the suite runs and `{"done":true}` once its export is written.
4. **Exit 0** when it does.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository, issues, pull requests, mutations, introspection |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (protocol v2), `git-receive-pack` (v0) |
| anything else | 404 `{"message":"Not Found"}` |

Every REST reply is `application/json` and carries a non-empty
`X-GitHub-Request-Id`. Auth is `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`;
a missing or wrong token is refused with 401 (except `/healthz`, which takes
none). A repository belongs to the login the token names; any other owner is
404, never 403.

## Git

- Object store in memory: loose objects plus packfiles, SHA-1, zlib from
  Node's stdlib. Packs are written plain (no deltas) and read back with
  OFS/REF delta resolution and trailer checksum verification.
- `upload-pack` speaks protocol v2 (`ls-refs` with peel/symrefs/unborn/
  ref-prefix, `fetch` with want/have/shallow/deepen, thin-pack aware) and
  v0 for older clients.
- `receive-pack` is v0: fast-forward only. A non-fast-forward update is
  refused per ref with `ng <ref> non-fast-forward` and the ref does not move;
  a mixed push applies the fast-forward half and reports one line per ref.
- Repositories can only be created through REST; a push never invents one.
  A missing repository is 404 on `GET /info/refs`.

## REST v3

Repositories (create/list/get/patch/delete, pagination with `Link` headers),
branches, commits, contents (create/update/delete with SHA conflict checks),
labels, issues (create with label validation, list with state/sort, patch,
comments) and pull requests (create, files, squash merge with conflict
detection — a conflicted merge is 405 and the pull stays open).

## GraphQL

A small lexer/parser/executor over the same store: `viewer`, `repository`
(with `issues`/`pullRequests` connections, `CREATED_AT DESC` ordering,
`states: [OPEN]`), `node(id:)` with opaque stable global ids, `__type` /
`__schema` introspection for `Issue`, `PullRequest` and `Repository`,
mutations `createIssue`, `closeIssue`, `createPullRequest`,
`mergePullRequest`, `addComment`, batched operations (an array body returns
one result per operation, in order), an unknown field is HTTP 200 with an
`errors` array, and an unknown repository is `data.repository: null` with no
errors.

## MCP

JSON-RPC 2.0 over streamable HTTP (protocol revision 2026-07-28, with legacy
`initialize` support): six tools — `create_repo`, `get_repo`,
`create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` —
on the same store as REST, so a repo or issue created over MCP is the same
object over REST. An unknown tool is `-32601`/`-32602`, never HTTP 500;
a non-JSON body is HTTP 400 with JSON-RPC `-32700`; a call without
`Authorization` is 401.

## Determinism

State is a pure function of the request sequence: fixed timestamps, fixed
scenario seed, no wall clock, port or date in any stored state, so a state
export is byte-identical across runs.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the HTTP server wiring.
- `git-core.ts`: pkt-line codec, object model, packfile read/write.
- `git-http.ts`: smart HTTP (info/refs, upload-pack, receive-pack).
- `store.ts`: the in-memory store (repos, objects, refs, issues, pulls).
- `scenario.ts`: the seeded scenario (viewer login derived from the seed).
- `rest.ts`: REST v3 router.
- `graphql.ts`: GraphQL lexer/parser/executor.
- `mcp.ts`: MCP (JSON-RPC 2.0) endpoint.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): metadata and licence.

## License

MIT. See [LICENSE](LICENSE).
