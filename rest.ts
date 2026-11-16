// REST v3: the /api/v3 surface the suite's restChecks / GraphQL fixtures / MCP setup speak to.
// Every reply is JSON and carries a non-empty X-GitHub-Request-Id. Auth is Bearer =
// MAKEFUN_SHOP_TOKEN; a missing token is 401; a repo owned by anyone other than the token's
// login is 404 (never 403).

import { hashObject, parseCommit, parseTag, parseTree } from './git-core.ts';
import {
  FIXED_TIMESTAMP,
  VIEWER_ID,
  VIEWER_LOGIN,
  store,
  viewerUser,
  type Comment,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({
  status,
  body,
  headers,
});
export const jsonError = (status: number, message: string): RestResult => ({ status, body: { message } });

export const viewerLogin = (): string => VIEWER_LOGIN;
export const viewerId = (): number => VIEWER_ID;

// ---------------------------------------------------------------------------------------------
// JSON shapes (GitHub-flavoured, only the fields the suite reads, plus the usual extras)
// ---------------------------------------------------------------------------------------------

export function userJson(): Record<string, unknown> {
  const viewer = viewerUser();
  return {
    login: viewer.login,
    id: viewer.id,
    type: 'User',
    name: viewer.name,
    email: viewer.email,
    avatar_url: `https://avatars.githubusercontent.com/u/${viewer.id}`,
    html_url: `https://github.com/${viewer.login}`,
    site_admin: false,
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
    pushed_at: FIXED_TIMESTAMP,
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    archived: false,
    disabled: false,
  };
}

/** A stable numeric id for a label: its 1-based position in the repo's label map. */
function labelId(repo: Repo, name: string): number {
  let i = 1;
  for (const key of repo.labels.keys()) {
    if (key === name) return i;
    i += 1;
  }
  return i;
}

export function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: labelId(repo, label.name),
    node_id: `LA_${labelId(repo, label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, repo.labels.get(name)!)),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignees: [],
    locked: false,
    comments: repo.comments.get(issue.number)?.length ?? 0,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headRef = pull.headRef;
  const baseRef = pull.baseRef;
  const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { label: `${repo.owner}:${headRef}`, ref: headRef, sha: headSha, repo: repoJson(repo) },
    base: { label: `${repo.owner}:${baseRef}`, ref: baseRef, sha: baseSha, repo: repoJson(repo) },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignees: [],
    requested_reviewers: [],
    labels: [],
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    mergeable: pull.merged ? true : !store.pullConflict(repo, pull),
    mergeable_state: pull.merged ? 'merged' : store.pullConflict(repo, pull) ? 'dirty' : 'clean',
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  // GitHub's API returns the commit message without the trailing newline the object stores.
  const message = commit.message.replace(/\n$/, '');
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      message,
      author: { name: commit.author.name, email: commit.author.email, date: commit.author.date },
      committer: { name: commit.committer.name, email: commit.committer.email, date: commit.committer.date },
      tree: { sha: commit.tree },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Pagination (Link header, GitHub style)
// ---------------------------------------------------------------------------------------------

function paginate<T>(items: T[], query: URLSearchParams, origin = ''): { page: T[]; link: string | null; total: number } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const base = query.get('__path') ?? '';
  const links: string[] = [];
  const linkFor = (p: number, rel: string) => {
    const q = new URLSearchParams(query);
    q.delete('__path');
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    links.push(`<${origin}${base}?${q.toString()}>; rel="${rel}"`);
  };
  if (page < totalPages) linkFor(page + 1, 'next');
  if (page > 1) linkFor(page - 1, 'prev');
  if (totalPages > 1) {
    linkFor(1, 'first');
    linkFor(totalPages, 'last');
  }
  return { page: slice, link: links.length > 0 ? links.join(', ') : null, total };
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

type Handler = (ctx: RestContext) => RestResult;

interface RestContext {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  owner: string;
  repo: string;
  origin: string;
}

function notFound(message = 'Not Found'): RestResult {
  return jsonError(404, message);
}

function repoOr404(ctx: RestContext): Repo | RestResult {
  if (ctx.owner !== VIEWER_LOGIN) return notFound('Not Found');
  const repo = store.getRepo(ctx.owner, ctx.repo);
  if (!repo) return notFound('Not Found');
  return repo;
}

const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];

function route(method: string, pattern: RegExp, handler: Handler): void {
  routes.push({ method, pattern, handler });
}

function matchRoute(method: string, path: string): { handler: Handler; params: string[] } | null {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(path);
    if (m) return { handler: r.handler, params: m.slice(1) };
  }
  return null;
}

/** Dispatch a REST request. `path` is the URL path after /api/v3 (no leading slash required).
 *  `origin` is the request's base URL (e.g. http://127.0.0.1:18080), used for absolute Link URLs. */
export function handleRest(
  method: string,
  rawPath: string,
  query: URLSearchParams,
  body: unknown,
  origin = '',
): RestResult {
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const matched = matchRoute(method, path);
  if (!matched) return notFound('Not Found');
  const params = matched.params;
  const ctx: RestContext = {
    method,
    path,
    query,
    body,
    owner: params[0] ? decodeURIComponent(params[0]) : '',
    repo: params[1] ? decodeURIComponent(params[1]) : '',
    origin,
  };
  // The rest of the params live on the context for the handler to read.
  (ctx as unknown as { params: string[] }).params = params;
  return matched.handler(ctx);
}

function params(ctx: RestContext): string[] {
  return (ctx as unknown as { params: string[] }).params;
}

function bodyObj(ctx: RestContext): Record<string, unknown> {
  return (ctx.body ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Root / meta / user
// ---------------------------------------------------------------------------------------------

route('GET', /^\/$/, () => {
  return ok(200, {
    current_user_url: '/api/v3/user',
    current_user_authorizations_html_url: 'https://github.com/settings/applications',
    authorizations_url: '/api/v3/authorizations',
    code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
    commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
    emails_url: '/api/v3/user/emails',
    emojis_url: '/api/v3/emojis',
    events_url: '/api/v3/events',
    feeds_url: '/api/v3/feeds',
    followers_url: '/api/v3/user/followers',
    following_url: '/api/v3/user/following{/target}',
    gists_url: '/api/v3/gists{/gist_id}',
    hub_url: 'https://api.github.com/hub',
    issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
    issues_url: '/api/v3/issues',
    keys_url: '/api/v3/user/keys',
    label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
    notifications_url: '/api/v3/notifications{?since,all,participating}',
    organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
    organization_url: '/api/v3/orgs/{org}',
    public_gists_url: '/api/v3/gists/public',
    rate_limit_url: '/api/v3/rate_limit',
    repository_url: '/api/v3/repos/{owner}/{repo}',
    repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
    current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
    starred_url: '/api/v3/user/starred{/owner}{/repo}',
    starred_gists_url: '/api/v3/gists/starred',
    topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
    user_url: '/api/v3/users/{user}',
    user_organizations_url: '/api/v3/user/orgs',
    user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
    user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
  });
});

route('GET', /^\/meta$/, () => ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true }));

route('GET', /^\/user$/, () => ok(200, userJson()));

route('GET', /^\/user\/repos$/, (ctx) => {
  const repos = store.listRepos(VIEWER_LOGIN);
  const q = new URLSearchParams(ctx.query);
  q.set('__path', '/api/v3/user/repos');
  const { page, link } = paginate(repos, q, ctx.origin);
  return ok(200, page.map(repoJson), link ? { Link: link } : undefined);
});

route('POST', /^\/user\/repos$/, (ctx) => {
  const b = bodyObj(ctx);
  const name = typeof b.name === 'string' ? b.name : '';
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return jsonError(422, 'name is required and must be a valid repository name');
  const repo = store.createRepo(VIEWER_LOGIN, name, typeof b.description === 'string' ? b.description : '', b.private === true);
  if (!repo) return jsonError(422, 'Repository creation failed. name already exists on this account');
  return ok(201, repoJson(repo));
});

// ---------------------------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------------------------

route('GET', /^\/repos\/([^/]+)\/([^/]+)$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  return ok(200, repoJson(repo));
});

route('PATCH', /^\/repos\/([^/]+)\/([^/]+)$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const b = bodyObj(ctx);
  if (typeof b.description === 'string') repo.description = b.description;
  if (typeof b.default_branch === 'string' && repo.refs.has(`refs/heads/${b.default_branch}`)) {
    repo.defaultBranch = b.default_branch;
  }
  if (typeof b.homepage === 'string') repo.description = repo.description;
  repo.updatedAt = FIXED_TIMESTAMP;
  return ok(200, repoJson(repo));
});

route('DELETE', /^\/repos\/([^/]+)\/([^/]+)$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  store.deleteRepo(ctx.owner, ctx.repo);
  return ok(204, null);
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/branches$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const names = [...repo.refs.keys()]
    .filter((name) => name.startsWith('refs/heads/'))
    .map((name) => name.slice('refs/heads/'.length))
    .sort();
  const branches = names.map((name) => ({
    name,
    commit: { sha: repo.refs.get(`refs/heads/${name}`), url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${repo.refs.get(`refs/heads/${name}`)}` },
    protected: false,
  }));
  return ok(200, branches);
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/branches\/([^/]+)$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const branch = decodeURIComponent(params(ctx)[2]!);
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (!sha) return notFound('Branch not found');
  return ok(200, {
    name: branch,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  });
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/commits$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const shaParam = ctx.query.get('sha');
  let tip: string | null = null;
  if (shaParam) {
    tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.objects.has(shaParam) ? shaParam : null);
  } else {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  if (!tip) return ok(200, []);
  const history = store.commitList(repo, tip);
  const out = history
    .map((entry) => commitJson(repo, entry.sha))
    .filter((x): x is Record<string, unknown> => x !== null);
  return ok(200, out);
});

route('POST', /^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const b = bodyObj(ctx);
  const ref = typeof b.ref === 'string' ? b.ref : '';
  const sha = typeof b.sha === 'string' ? b.sha : '';
  if (!ref.startsWith('refs/') || !sha || !repo.objects.has(sha)) {
    return jsonError(422, 'Invalid request. ref and sha are required, and sha must be an existing object');
  }
  if (repo.refs.has(ref)) return jsonError(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  const type = repo.objects.get(sha)?.type ?? 'commit';
  return ok(201, { ref, node_id: `REF_${ref}`, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type } });
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/(.+)$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const ref = decodeURIComponent(params(ctx)[2]!);
  const fullRef = ref.startsWith('refs/') ? ref : `refs/${ref}`;
  const sha = repo.refs.get(fullRef);
  if (!sha) return notFound('Reference not found');
  const type = repo.objects.get(sha)?.type ?? 'commit';
  return ok(200, { ref: fullRef, node_id: `REF_${fullRef}`, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${encodeURIComponent(fullRef)}`, object: { sha, type } });
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const refs = store.sortedRefs(repo).map((r) => {
    const type = repo.objects.get(r.oid)?.type ?? 'commit';
    return { ref: r.name, node_id: `REF_${r.name}`, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${encodeURIComponent(r.name)}`, object: { sha: r.oid, type } };
  });
  return ok(200, refs);
});

// ---------------------------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------------------------

function resolveRef(repo: Repo, refParam: string | null): string | null {
  if (!refParam) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  return repo.refs.get(`refs/heads/${refParam}`) ?? (repo.objects.has(refParam) ? refParam : null);
}

/** The flat path map of a branch's tip (empty when the branch does not exist). */
function branchPaths(repo: Repo, branch: string): Map<string, { oid: string; mode: string }> {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  return tip ? store.treePaths(repo, tip) : new Map();
}

function contentEntry(repo: Repo, path: string, oid: string, isDir: boolean): Record<string, unknown> {
  return {
    type: isDir ? 'dir' : 'file',
    name: path.split('/').pop() ?? path,
    path,
    sha: oid,
    size: isDir ? 0 : (repo.objects.get(oid)?.data.length ?? 0),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(path)}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
    _links: { self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(path)}` },
  };
}

route('PUT', /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const path = decodeURIComponent(params(ctx)[2]!);
  const b = bodyObj(ctx);
  const message = typeof b.message === 'string' ? b.message : 'Update file';
  const contentB64 = typeof b.content === 'string' ? b.content : '';
  const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
  const shaParam = typeof b.sha === 'string' ? b.sha : null;
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    return jsonError(422, 'content must be base64-encoded');
  }
  const branchExists = repo.refs.has(`refs/heads/${branch}`);
  // A write to a branch that does not exist yet starts from the default branch's tree.
  const paths = branchExists ? branchPaths(repo, branch) : branchPaths(repo, repo.defaultBranch);
  const existing = paths.get(path);
  if (shaParam) {
    // Update: the file must exist and the sha must match.
    if (!existing) return notFound('Not Found');
    if (existing.oid !== shaParam) return jsonError(409, 'sha does not match the current file');
  } else if (existing && branchExists) {
    return jsonError(409, 'file already exists');
  }
  const baseCommit = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const blobOid = hashObject('blob', content);
  repo.objects.set(blobOid, { type: 'blob', data: content });
  const next = new Map(paths);
  next.set(path, { oid: blobOid, mode: '100644' });
  const commitSha = store.commitOnBranch(repo, branch, next, message, baseCommit);
  const isCreate = !shaParam;
  return ok(isCreate ? 201 : 200, {
    content: {
      ...contentEntry(repo, path, blobOid, false),
      encoding: 'base64',
      content: contentB64,
    },
    commit: { sha: commitSha, message, author: { name: 'Conformance', email: 'conformance@make.fun' }, committer: { name: 'Conformance', email: 'conformance@make.fun' } },
  });
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const path = decodeURIComponent(params(ctx)[2]!);
  const tip = resolveRef(repo, ctx.query.get('ref'));
  if (!tip) return notFound('Not Found');
  const paths = store.treePaths(repo, tip);
  const entry = paths.get(path);
  if (entry) {
    const object = repo.objects.get(entry.oid);
    if (!object) return notFound('Not Found');
    return ok(200, {
      ...contentEntry(repo, path, entry.oid, false),
      encoding: 'base64',
      content: object.data.toString('base64'),
    });
  }
  // Directory listing: any path that is a prefix of a stored path.
  const prefix = `${path}/`;
  const children = new Map<string, { oid: string; isDir: boolean }>();
  for (const [p, e] of paths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) children.set(rest, { oid: e.oid, isDir: false });
    else children.set(rest.slice(0, slash), { oid: e.oid, isDir: true });
  }
  if (children.size === 0) return notFound('Not Found');
  const listing = [...children.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, e]) => contentEntry(repo, `${path}/${name}`, e.oid, e.isDir));
  return ok(200, listing);
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/contents$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const tip = resolveRef(repo, ctx.query.get('ref'));
  if (!tip) return ok(200, []);
  const paths = store.treePaths(repo, tip);
  const children = new Map<string, { oid: string; isDir: boolean }>();
  for (const [p, e] of paths) {
    const slash = p.indexOf('/');
    if (slash < 0) children.set(p, { oid: e.oid, isDir: false });
    else children.set(p.slice(0, slash), { oid: e.oid, isDir: true });
  }
  const listing = [...children.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, e]) => contentEntry(repo, name, e.oid, e.isDir));
  return ok(200, listing);
});

route('DELETE', /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const path = decodeURIComponent(params(ctx)[2]!);
  const b = bodyObj(ctx);
  const message = typeof b.message === 'string' ? b.message : 'Delete file';
  const shaParam = typeof b.sha === 'string' ? b.sha : null;
  const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
  const paths = branchPaths(repo, branch);
  const existing = paths.get(path);
  if (!existing) return notFound('Not Found');
  if (shaParam && existing.oid !== shaParam) return jsonError(409, 'sha does not match the current file');
  const next = new Map(paths);
  next.delete(path);
  const commitSha = store.commitOnBranch(repo, branch, next, message);
  return ok(200, {
    commit: { sha: commitSha, message, author: { name: 'Conformance', email: 'conformance@make.fun' }, committer: { name: 'Conformance', email: 'conformance@make.fun' } },
  });
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/readme$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const tip = resolveRef(repo, ctx.query.get('ref'));
  if (!tip) return notFound('Not Found');
  const paths = store.treePaths(repo, tip);
  const readme = [...paths.keys()].find((p) => /^readme(\.[a-z]+)?$/i.test(p.split('/').pop() ?? ''));
  if (!readme) return notFound('Not Found');
  const entry = paths.get(readme)!;
  const object = repo.objects.get(entry.oid);
  if (!object) return notFound('Not Found');
  return ok(200, {
    ...contentEntry(repo, readme, entry.oid, false),
    encoding: 'base64',
    content: object.data.toString('base64'),
  });
});

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

route('POST', /^\/repos\/([^/]+)\/([^/]+)\/labels$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const b = bodyObj(ctx);
  const name = typeof b.name === 'string' ? b.name : '';
  if (!name) return jsonError(422, 'name is required');
  if (repo.labels.get(name)) return jsonError(422, 'Label already exists');
  const color = typeof b.color === 'string' ? b.color.replace(/^#/, '') : 'ededed';
  const label = store.createLabel(repo, name, color);
  return ok(201, labelJson(repo, label));
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/labels$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  return ok(200, [...repo.labels.values()].map((label) => labelJson(repo, label)));
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/labels\/([^/]+)$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const name = decodeURIComponent(params(ctx)[2]!);
  const label = repo.labels.get(name);
  if (!label) return notFound('Label not found');
  return ok(200, labelJson(repo, label));
});

// ---------------------------------------------------------------------------------------------
// Issues + comments
// ---------------------------------------------------------------------------------------------

route('POST', /^\/repos\/([^/]+)\/([^/]+)\/issues$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const b = bodyObj(ctx);
  const title = typeof b.title === 'string' ? b.title : '';
  if (!title) return jsonError(422, 'title is required');
  const labels = Array.isArray(b.labels) ? (b.labels as unknown[]).map(String) : [];
  const result = store.createIssue(repo, title, typeof b.body === 'string' ? b.body : '', labels);
  if ('error' in result) return jsonError(422, result.error);
  return ok(201, issueJson(repo, result));
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/issues$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const state = (ctx.query.get('state') ?? 'open') as 'open' | 'closed' | 'all';
  const sort = (ctx.query.get('sort') ?? 'created') as 'created' | 'updated';
  const direction = (ctx.query.get('direction') ?? 'desc') as 'asc' | 'desc';
  const issues = store.listIssues(repo, state === 'all' ? 'all' : state, sort, direction);
  const q = new URLSearchParams(ctx.query);
  q.set('__path', `/api/v3/repos/${ctx.owner}/${ctx.repo}/issues`);
  const { page, link } = paginate(issues, q, ctx.origin);
  return ok(200, page.map((i) => issueJson(repo, i)), link ? { Link: link } : undefined);
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const number = Number(params(ctx)[2]);
  const issue = repo.issues.get(number);
  if (!issue) return notFound('Not Found');
  return ok(200, issueJson(repo, issue));
});

route('PATCH', /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const number = Number(params(ctx)[2]);
  const issue = repo.issues.get(number);
  if (!issue) return notFound('Not Found');
  const b = bodyObj(ctx);
  if (typeof b.title === 'string') issue.title = b.title;
  if (typeof b.body === 'string') issue.body = b.body;
  if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
  if (Array.isArray(b.labels)) {
    const names = (b.labels as unknown[]).map(String);
    for (const name of names) {
      if (!repo.labels.get(name)) return jsonError(422, `Label does not exist: ${name}`);
    }
    issue.labels = names;
  }
  issue.updatedAt = FIXED_TIMESTAMP;
  return ok(200, issueJson(repo, issue));
});

route('POST', /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const number = Number(params(ctx)[2]);
  const issue = repo.issues.get(number);
  if (!issue) return notFound('Not Found');
  const b = bodyObj(ctx);
  const bodyText = typeof b.body === 'string' ? b.body : '';
  if (!bodyText) return jsonError(422, 'body is required');
  const comment = store.createComment(repo, number, bodyText);
  return ok(201, commentJson(repo, issue, comment));
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const number = Number(params(ctx)[2]);
  const issue = repo.issues.get(number);
  if (!issue) return notFound('Not Found');
  const comments = repo.comments.get(number) ?? [];
  return ok(200, comments.map((c) => commentJson(repo, issue, c)));
});

// ---------------------------------------------------------------------------------------------
// Pulls
// ---------------------------------------------------------------------------------------------

route('POST', /^\/repos\/([^/]+)\/([^/]+)\/pulls$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const b = bodyObj(ctx);
  const title = typeof b.title === 'string' ? b.title : '';
  const head = typeof b.head === 'string' ? b.head : '';
  const base = typeof b.base === 'string' ? b.base : repo.defaultBranch;
  if (!title || !head) return jsonError(422, 'title and head are required');
  const result = store.createPull(repo, title, typeof b.body === 'string' ? b.body : '', head, base);
  if ('error' in result) return jsonError(result.status, result.error);
  return ok(201, pullJson(repo, result));
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/pulls$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const state = ctx.query.get('state') ?? 'open';
  const pulls = store.listPulls(repo, state as 'open' | 'closed' | 'all');
  const q = new URLSearchParams(ctx.query);
  q.set('__path', `/api/v3/repos/${ctx.owner}/${ctx.repo}/pulls`);
  const { page, link } = paginate(pulls, q, ctx.origin);
  return ok(200, page.map((p) => pullJson(repo, p)), link ? { Link: link } : undefined);
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const number = Number(params(ctx)[2]);
  const pull = repo.pulls.get(number);
  if (!pull) return notFound('Not Found');
  return ok(200, pullJson(repo, pull));
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const number = Number(params(ctx)[2]);
  const pull = repo.pulls.get(number);
  if (!pull) return notFound('Not Found');
  const files = store.pullFiles(repo, pull).map((f) => ({
    sha: f.sha,
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${pull.headSha}/${f.filename}`,
    raw_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${pull.headSha}/${f.filename}`,
    contents_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(f.filename)}?ref=${pull.headRef}`,
    patch: f.patch,
  }));
  return ok(200, files);
});

route('PUT', /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/, (ctx) => {
  const repo = repoOr404(ctx);
  if ('status' in repo) return repo;
  const number = Number(params(ctx)[2]);
  const pull = repo.pulls.get(number);
  if (!pull) return notFound('Not Found');
  if (pull.merged) return jsonError(422, 'Pull Request is already merged');
  const b = bodyObj(ctx);
  const method = typeof b.merge_method === 'string' ? b.merge_method : 'squash';
  const result = store.mergePull(repo, pull, method);
  if ('error' in result) return jsonError(result.status, result.error);
  return ok(200, { sha: result.sha, merged: true, message: `Pull Request successfully merged` });
});

// ---------------------------------------------------------------------------------------------
// Extra: objects used by GraphQL's global-id resolution (exported for the GraphQL module)
// ---------------------------------------------------------------------------------------------

export function repoByOwnerName(owner: string, name: string): Repo | null {
  return store.getRepo(owner, name);
}

export { parseCommit, parseTag, parseTree };
