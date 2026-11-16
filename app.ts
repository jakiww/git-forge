// The forge's HTTP server: git smart HTTP, REST v3, GraphQL, MCP, and /healthz, in one process.
// main.ts owns the lifecycle (bind ephemeral port, register, poll /done); this file owns the
// surface. Only Node stdlib is used; the store is in-memory and deterministic.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': nextRequestId(), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextRequestId(), ...headers });
  res.end(body);
}

function parseUrl(req: IncomingMessage): { pathname: string; search: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, search: url.searchParams };
  } catch {
    return { pathname: '/', search: new URLSearchParams() };
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Bearer auth for the API surfaces. A missing or wrong token is 401. When MAKEFUN_SHOP_TOKEN
 * is unset (local development), any non-empty Bearer token is accepted, but the header must
 * still be present — the no-token case is always 401.
 */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token.length === 0) return false;
  if (SHOP_TOKEN.length > 0 && token !== SHOP_TOKEN) return false;
  return true;
}

function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** The request's base URL (http://host), for absolute Link header URLs. */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  if (!host) return '';
  return `http://${host}`;
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const { pathname, search } = parseUrl(req);
      const method = req.method ?? 'GET';
      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // REST v3.
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const restPath = pathname === '/api/v3' ? '/' : pathname.slice('/api/v3'.length);
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          let parsed: unknown = {};
          if (body.length > 0) {
            const result = parseJsonBody(body);
            if (!result.ok) {
              sendJson(res, 400, { message: 'Problems parsing JSON' });
              return;
            }
            parsed = result.value;
          }
          const outcome = handleRest(method, restPath, search, parsed, originOf(req));
          const headers: Record<string, string> = { 'x-oauth-scopes': 'repo, user' };
          if (outcome.headers) Object.assign(headers, outcome.headers);
          sendJson(res, outcome.status, outcome.body, headers);
          return;
        }

        // GraphQL.
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const body = await readBody(req);
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { data: null, errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          const outcome = handleGraphQL(parsed.value);
          sendJson(res, 200, outcome);
          return;
        }

        // MCP.
        if (pathname === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const body = await readBody(req);
          const headers: Record<string, string | undefined> = {};
          for (const [key, value] of Object.entries(req.headers)) headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
          const outcome = handleMcp(body, headers);
          if (outcome.body === null) {
            res.writeHead(outcome.status, { 'x-github-request-id': nextRequestId(), ...(outcome.headers ?? {}) });
            res.end();
            return;
          }
          sendJson(res, outcome.status, outcome.body, outcome.headers ?? {});
          return;
        }

        // Git smart HTTP.
        const gitMatch = GIT_PATH.exec(pathname);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const action = gitMatch[3]!;
          const repo = store.getRepo(owner, repoName);
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (action === 'info/refs') {
            if (method !== 'GET') {
              sendJson(res, 405, { message: 'Method Not Allowed' });
              return;
            }
            const service = search.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'service is required' });
              return;
            }
            const gitProtocol = req.headers['git-protocol'] ?? null;
            const outcome = handleInfoRefs(repo, service, typeof gitProtocol === 'string' ? gitProtocol : null);
            sendBuffer(res, outcome.status, outcome.contentType, outcome.body);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(req);
          const gitProtocol = req.headers['git-protocol'] ?? null;
          const protocol = typeof gitProtocol === 'string' ? gitProtocol : null;
          if (action === 'git-upload-pack') {
            const outcome = handleUploadPack(repo, body, protocol);
            sendBuffer(res, outcome.status, outcome.contentType, outcome.body);
            return;
          }
          const outcome = handleReceivePack(repo, body);
          sendBuffer(res, outcome.status, outcome.contentType, outcome.body);
          return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: (err as Error).message });
        } else {
          res.destroy();
        }
      }
    })();
  });
}
