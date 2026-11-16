// MCP at /mcp: JSON-RPC 2.0 Streamable HTTP. Supports the 2026-07-28 revision (server/discover,
// no handshake, _meta protocolVersion, MCP-Protocol-version header, mirrored Mcp-Method /
// Mcp-Name headers) and the legacy eras (initialize + notifications/initialized, Mcp-Session-Id).
// Six tools, all on the same store as REST: create_repo, get_repo, create_issue, list_issues,
// create_pull_request, merge_pull_request.

import { VIEWER_LOGIN, store, type Issue, type PullRequest, type Repo } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SESSION_ID = 'git-forge-session-1';

export interface McpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

// The tool list is a fixed constant, so two tools/list calls serialize byte-identically.
const TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply to the issue.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter issues by state.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The name of the branch where the changes are implemented.' },
        base: { type: 'string', description: 'The name of the branch to merge the changes into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function toolText(payload: unknown): string {
  return JSON.stringify(payload);
}

function toolResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: toolText(payload) }], structuredContent: payload };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArg(name: string): Record<string, unknown> {
  return toolError(`Missing required argument: ${name}`);
}

function repoOrError(owner: string, repo: string): Repo | Record<string, unknown> {
  if (owner !== VIEWER_LOGIN) return toolError(`Repository not found: ${owner}/${repo}`);
  const found = store.getRepo(owner, repo);
  if (!found) return toolError(`Repository not found: ${owner}/${repo}`);
  return found;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const str = (key: string): string | undefined => {
    const v = args[key];
    return typeof v === 'string' ? v : undefined;
  };
  switch (name) {
    case 'create_repo': {
      const repoName = str('name');
      if (!repoName) return missingArg('name');
      const repo = store.createRepo(VIEWER_LOGIN, repoName, str('description') ?? '', args.private === true);
      if (!repo) return toolError(`Repository already exists: ${repoName}`);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const owner = str('owner');
      const repoName = str('repo');
      if (!owner) return missingArg('owner');
      if (!repoName) return missingArg('repo');
      const repo = repoOrError(owner, repoName);
      if ('content' in repo) return repo;
      return toolResult(repoJson(repo as Repo));
    }
    case 'create_issue': {
      const owner = str('owner');
      const repoName = str('repo');
      const title = str('title');
      if (!owner) return missingArg('owner');
      if (!repoName) return missingArg('repo');
      if (!title) return missingArg('title');
      const repo = repoOrError(owner, repoName);
      if ('content' in repo) return repo;
      const labels = Array.isArray(args.labels) ? (args.labels as unknown[]).map(String) : [];
      const result = store.createIssue(repo as Repo, title, str('body') ?? '', labels);
      if ('error' in result) return toolError(result.error);
      return toolResult(issueJson(repo as Repo, result));
    }
    case 'list_issues': {
      const owner = str('owner');
      const repoName = str('repo');
      if (!owner) return missingArg('owner');
      if (!repoName) return missingArg('repo');
      const repo = repoOrError(owner, repoName);
      if ('content' in repo) return repo;
      const state = (str('state') ?? 'open') as 'open' | 'closed' | 'all';
      const issues = store.listIssues(repo as Repo, state, 'created', 'desc');
      return toolResult(issues.map((issue) => issueJson(repo as Repo, issue)));
    }
    case 'create_pull_request': {
      const owner = str('owner');
      const repoName = str('repo');
      const title = str('title');
      const head = str('head');
      const base = str('base');
      if (!owner) return missingArg('owner');
      if (!repoName) return missingArg('repo');
      if (!title) return missingArg('title');
      if (!head) return missingArg('head');
      if (!base) return missingArg('base');
      const repo = repoOrError(owner, repoName);
      if ('content' in repo) return repo;
      const result = store.createPull(repo as Repo, title, str('body') ?? '', head, base);
      if ('error' in result) return toolError(result.error);
      return toolResult(pullJson(repo as Repo, result));
    }
    case 'merge_pull_request': {
      const owner = str('owner');
      const repoName = str('repo');
      const pullNumber = args.pull_number;
      if (!owner) return missingArg('owner');
      if (!repoName) return missingArg('repo');
      if (typeof pullNumber !== 'number') return missingArg('pull_number');
      const repo = repoOrError(owner, repoName);
      if ('content' in repo) return repo;
      const pull = (repo as Repo).pulls.get(pullNumber);
      if (!pull) return toolError(`Pull request not found: #${pullNumber}`);
      if (pull.merged) return toolError(`Pull request #${pullNumber} is already merged`);
      const result = store.mergePull(repo as Repo, pull, 'squash');
      if ('error' in result) return toolError(result.error);
      return toolResult({ sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

const JSONRPC_VERSION = '2.0';

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}
function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

/**
 * Handle one MCP request. `headers` are the request headers (lower-cased names). The response
 * mirrors the MCP-Protocol-Version / Mcp-Method / Mcp-Name headers the client sent, and sets
 * Mcp-Session-Id for the legacy initialize flow.
 */
export function handleMcp(rawBody: Buffer, headers: Record<string, string | undefined>): McpResult {
  const mirror: Record<string, string> = {};
  const protocolVersion = headers['mcp-protocol-version'];
  if (protocolVersion) mirror['MCP-Protocol-Version'] = protocolVersion;
  const mcpMethod = headers['mcp-method'];
  if (mcpMethod) mirror['Mcp-Method'] = mcpMethod;
  const mcpName = headers['mcp-name'];
  if (mcpName) mirror['Mcp-Name'] = mcpName;

  let request: Record<string, unknown>;
  try {
    request = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    return {
      status: 400,
      body: rpcError(null, -32700, 'Parse error: request body is not valid JSON'),
      headers: mirror,
    };
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request'), headers: mirror };
  }
  const id = request.id ?? null;
  const isNotification = id === null || id === undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // Notifications get a 202 with no body.
  if (isNotification) {
    return { status: 202, body: null, headers: mirror };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: '2026-07-28',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
      headers: { ...mirror, 'MCP-Protocol-Version': '2026-07-28' },
    };
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const negotiated = requested && SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
      headers: { ...mirror, 'MCP-Protocol-Version': negotiated, 'Mcp-Session-Id': SESSION_ID },
    };
  }
  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}), headers: mirror };
  }
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }), headers: mirror };
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
    const known = TOOLS.some((tool) => tool.name === toolName);
    if (!known) {
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${toolName}`), headers: mirror };
    }
    const result = callTool(toolName, toolArgs);
    return { status: 200, body: rpcResult(id, result), headers: mirror };
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`), headers: mirror };
}
