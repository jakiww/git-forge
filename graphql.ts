// GraphQL at /api/graphql: a small, strict-enough parser + executor for the shapes the suite
// uses (viewer, repository, node, __type introspection, issues/pulls connections with cursor
// pagination, and the create/close/merge/addComment mutations). Global ids are the same opaque
// base64url ids as the store's globalId(). Unknown fields produce an HTTP 200 response with an
// errors array naming the field (the suite's invalid-field check); an unknown repository is
// data.repository: null with no errors.

import { FIXED_TIMESTAMP, VIEWER_ID, VIEWER_LOGIN, globalId, parseGlobalId, store, type Issue, type PullRequest, type Repo } from './store.ts';

// ---------------------------------------------------------------------------------------------
// Lexer + parser
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string) => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string) => /[_0-9A-Za-z]/.test(c);
  const isDigit = (c: string) => /[0-9]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$()[]{}:=@|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (c === '-' || isDigit(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && isDigit(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && isDigit(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && isDigit(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && isDigit(source[j]!)) j += 1;
      }
      const raw = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: raw } : { kind: 'int', value: raw });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

type TypeNode =
  | { kind: 'named'; name: string }
  | { kind: 'list'; ofType: TypeNode }
  | { kind: 'nonNull'; ofType: TypeNode };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selections?: SelectionNode[];
}
interface SpreadNode {
  kind: 'spread';
  name: string;
}
interface InlineNode {
  kind: 'inline';
  typeCondition?: string;
  selections: SelectionNode[];
}
type SelectionNode = FieldNode | SpreadNode | InlineNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variables: Array<{ name: string; type: TypeNode; defaultValue?: ValueNode }>;
  selections: SelectionNode[];
}
interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}
type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private tokens: Token[];
  private pos = 0;
  constructor(source: string) {
    this.tokens = lex(source);
  }
  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(t)}`);
  }
  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(t)}`);
    if (value !== undefined && t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
    return t.value;
  }
  private acceptPunct(value: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'operation', operation: 'query', variables: [], selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | undefined;
      const nt = this.peek();
      if (nt.kind === 'name') name = this.next().value as string;
      const variables = this.parseVariableDefinitions();
      return { kind: 'operation', operation, name, variables, selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    throw new Error(`unexpected definition ${JSON.stringify(t)}`);
  }

  private parseVariableDefinitions(): Array<{ name: string; type: TypeNode; defaultValue?: ValueNode }> {
    const defs: Array<{ name: string; type: TypeNode; defaultValue?: ValueNode }> = [];
    if (!this.acceptPunct('(')) return defs;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.acceptPunct('=')) defaultValue = this.parseValue();
      defs.push({ name, type, defaultValue });
    }
    return defs;
  }

  private parseType(): TypeNode {
    let type: TypeNode;
    if (this.acceptPunct('[')) {
      const inner = this.parseType();
      this.expectPunct(']');
      type = { kind: 'list', ofType: inner };
    } else {
      type = { kind: 'named', name: this.expectName() };
    }
    if (this.acceptPunct('!')) type = { kind: 'nonNull', ofType: type };
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (t.kind === 'name') {
        return { kind: 'spread', name: this.next().value as string };
      }
      return { kind: 'inline', selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    let selections: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
      return Number.parseInt(node.value, 10);
    case 'float':
      return Number.parseFloat(node.value);
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Introspection data (the __type fields the suite checks)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository', 'closed', 'closedAt', 'locked', 'milestone', 'assignees', 'participants', 'timelineItems', 'viewerCanUpdate', 'viewerDidAuthor'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'url', 'createdAt', 'updatedAt', 'author', 'files', 'repository', 'closed', 'closedAt', 'locked', 'additions', 'deletions', 'changedFiles', 'commits', 'reviews', 'reviewDecision', 'isDraft', 'mergeStateStatus'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'createdAt', 'updatedAt', 'url', 'homepageUrl', 'isPrivate', 'forkCount', 'stargazerCount', 'watcherCount', 'hasWikiEnabled', 'hasProjectsEnabled', 'licenseInfo', 'primaryLanguage', 'languages', 'topics', 'refs', 'defaultBranch', 'diskUsage', 'isArchived', 'isDisabled', 'isEmpty', 'isFork', 'isLocked', 'isMirror', 'isTemplate', 'visibility', 'viewerCanAdminister', 'viewerHasStarred', 'viewerSubscription'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'createdAt', 'updatedAt'],
  IssueComment: ['id', 'databaseId', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  Ref: ['id', 'name', 'target', 'associatedPullRequests'],
  RepositoryOwner: ['id', 'login', 'avatarUrl', 'url', 'repositories'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Actor: ['login', 'avatarUrl', 'url'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'LABEL', 'MILESTONE', 'ORGANIZATION', 'PROJECT', 'TOPIC', 'PACKAGE', 'WIKI', 'PULL_REQUEST'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  IssueOrder: ['field', 'direction'],
  PullRequestOrder: ['field', 'direction'],
};

const TYPE_KIND: Record<string, string> = {
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  Repository: 'OBJECT',
  User: 'OBJECT',
  IssueComment: 'OBJECT',
  Label: 'OBJECT',
  Ref: 'OBJECT',
  RepositoryOwner: 'OBJECT',
  PageInfo: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  Actor: 'INTERFACE',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  RepositoryPermission: 'ENUM',
  MergeableState: 'ENUM',
  OrderDirection: 'ENUM',
  IssueOrderField: 'ENUM',
  PullRequestOrderField: 'ENUM',
};

// ---------------------------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------------------------

type Source = Record<string, unknown> & { __typename?: string; __repo?: Repo };

function userSource(): Source {
  return { __typename: 'User', login: VIEWER_LOGIN, id: globalId('User', VIEWER_LOGIN), databaseId: VIEWER_ID, name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid` };
}

function ownerSource(repo: Repo): Source {
  return { __typename: 'RepositoryOwner', login: repo.owner, id: globalId('User', repo.owner), databaseId: repo.id };
}

function repoSource(repo: Repo): Source {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: globalId('Repository', repo.owner, repo.name),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    isPrivate: repo.isPrivate,
    isArchived: false,
    isDisabled: false,
    isEmpty: repo.refs.size === 0,
    isFork: false,
    isLocked: false,
    isMirror: false,
    isTemplate: false,
    visibility: repo.isPrivate ? 'PRIVATE' : 'PUBLIC',
    forkCount: 0,
    stargazerCount: 0,
    watcherCount: 0,
    diskUsage: 0,
    hasIssuesEnabled: true,
    hasWikiEnabled: true,
    hasProjectsEnabled: true,
    viewerPermission: 'ADMIN',
    viewerCanAdminister: true,
    viewerHasStarred: false,
    viewerSubscription: 'IGNORED',
    owner: ownerSource(repo),
    defaultBranch: repo.defaultBranch,
  };
}

function issueSource(repo: Repo, issue: Issue): Source {
  return {
    __typename: 'Issue',
    __repo: repo,
    id: globalId('Issue', repo.owner, repo.name, issue.number),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.state === 'closed' ? issue.updatedAt : null,
    closed: issue.state === 'closed',
    locked: false,
    viewerCanUpdate: true,
    viewerDidAuthor: true,
    author: userSource(),
    labels: issue.labels,
  };
}

function pullSource(repo: Repo, pull: PullRequest): Source {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const files = store.pullFiles(repo, pull);
  return {
    __typename: 'PullRequest',
    __repo: repo,
    id: globalId('PullRequest', repo.owner, repo.name, pull.number),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state.toUpperCase(),
    merged: pull.merged,
    mergeable: pull.merged ? 'UNKNOWN' : store.pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: headSha,
    baseRefOid: baseSha,
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    closedAt: pull.state === 'closed' ? pull.updatedAt : null,
    closed: pull.state === 'closed',
    locked: false,
    isDraft: false,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    changedFiles: files.length,
    author: userSource(),
    files,
  };
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}
function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return -1;
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(raw);
    return m ? Number.parseInt(m[1]!, 10) : -1;
  } catch {
    return -1;
  }
}

interface ConnectionArgs {
  first?: number;
  after?: string;
  states?: string[];
  orderBy?: { field?: string; direction?: string };
}

function connection<T>(items: T[], args: ConnectionArgs): Source {
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : items.length;
  const afterIndex = decodeCursor(args.after);
  const start = afterIndex + 1;
  const page = items.slice(start, start + first);
  const endIndex = start + page.length - 1;
  return {
    __typename: 'Connection',
    nodes: page,
    edges: page.map((node, i) => ({ __typename: 'Edge', node, cursor: encodeCursor(start + i) })),
    totalCount: items.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: endIndex + 1 < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? encodeCursor(start) : null,
      endCursor: page.length > 0 ? encodeCursor(endIndex) : null,
    },
  };
}

function sortIssues(issues: Issue[], orderBy?: { field?: string; direction?: string }): Issue[] {
  const direction = (orderBy?.direction ?? 'DESC').toUpperCase();
  const sorted = [...issues].sort((a, b) => a.number - b.number);
  return direction === 'DESC' ? sorted.reverse() : sorted;
}
function sortPulls(pulls: PullRequest[], orderBy?: { field?: string; direction?: string }): PullRequest[] {
  const direction = (orderBy?.direction ?? 'DESC').toUpperCase();
  const sorted = [...pulls].sort((a, b) => a.number - b.number);
  return direction === 'DESC' ? sorted.reverse() : sorted;
}

type Resolver = (source: Source, args: Record<string, unknown>) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userSource(),
    repository: (_source, args) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== VIEWER_LOGIN) return null;
      const repo = store.getRepo(owner, name);
      return repo ? repoSource(repo) : null;
    },
    node: (_source, args) => {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (!parsed) return null;
      const { kind, parts } = parsed;
      if (kind === 'Repository' && parts.length >= 2) {
        const repo = store.getRepo(parts[0]!, parts[1]!);
        return repo ? repoSource(repo) : null;
      }
      if (kind === 'Issue' && parts.length >= 3) {
        const repo = store.getRepo(parts[0]!, parts[1]!);
        const issue = repo?.issues.get(Number(parts[2]));
        return repo && issue ? issueSource(repo, issue) : null;
      }
      if (kind === 'PullRequest' && parts.length >= 3) {
        const repo = store.getRepo(parts[0]!, parts[1]!);
        const pull = repo?.pulls.get(Number(parts[2]));
        return repo && pull ? pullSource(repo, pull) : null;
      }
      if (kind === 'User' && parts.length >= 1) return userSource();
      return null;
    },
    __type: (_source, args) => {
      const name = String(args.name ?? '');
      if (!TYPE_FIELDS[name] && !TYPE_ENUM_VALUES[name]) return null;
      return {
        __typename: '__Type',
        name,
        kind: TYPE_KIND[name] ?? 'OBJECT',
        description: null,
        fields: (TYPE_FIELDS[name] ?? []).map((field) => ({ __typename: '__Field', name: field, description: null, type: { __typename: '__Type', name: 'String', kind: 'SCALAR' } })),
        enumValues: (TYPE_ENUM_VALUES[name] ?? []).map((value) => ({ __typename: '__EnumValue', name: value, description: null })),
      };
    },
    __schema: () => ({ __typename: '__Schema', queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' }, mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' }, types: [] }),
  },
  Mutation: {
    createIssue: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      if (!parsed || parsed.kind !== 'Repository' || parsed.parts.length < 2) throw new Error('repositoryId does not identify a repository');
      const repo = store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
      if (!repo) throw new Error('repository not found');
      const result = store.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      if ('error' in result) throw new Error(result.error);
      return { __typename: 'CreateIssuePayload', issue: issueSource(repo, result), clientMutationId: (input.clientMutationId as string) ?? null };
    },
    closeIssue: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      if (!parsed || parsed.kind !== 'Issue' || parsed.parts.length < 3) throw new Error('issueId does not identify an issue');
      const repo = store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
      const issue = repo?.issues.get(Number(parsed.parts[2]));
      if (!repo || !issue) throw new Error('issue not found');
      issue.state = 'closed';
      issue.updatedAt = FIXED_TIMESTAMP;
      return { __typename: 'CloseIssuePayload', issue: issueSource(repo, issue), clientMutationId: (input.clientMutationId as string) ?? null };
    },
    createPullRequest: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      if (!parsed || parsed.kind !== 'Repository' || parsed.parts.length < 2) throw new Error('repositoryId does not identify a repository');
      const repo = store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
      if (!repo) throw new Error('repository not found');
      const result = store.createPull(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', String(input.headRefName ?? ''), String(input.baseRefName ?? repo.defaultBranch));
      if ('error' in result) throw new Error(result.error);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(repo, result), clientMutationId: (input.clientMutationId as string) ?? null };
    },
    mergePullRequest: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      if (!parsed || parsed.kind !== 'PullRequest' || parsed.parts.length < 3) throw new Error('pullRequestId does not identify a pull request');
      const repo = store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
      const pull = repo?.pulls.get(Number(parsed.parts[2]));
      if (!repo || !pull) throw new Error('pull request not found');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
      const merged = store.mergePull(repo, pull, method);
      if ('error' in merged) throw new Error(merged.error);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(repo, pull), clientMutationId: (input.clientMutationId as string) ?? null };
    },
    addComment: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      if (!parsed || parsed.parts.length < 3) throw new Error('subjectId does not identify an issue or pull request');
      const repo = store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
      if (!repo) throw new Error('subject not found');
      const bodyText = typeof input.body === 'string' ? input.body : '';
      let subject: Source | null = null;
      let comment: Source | null = null;
      if (parsed.kind === 'Issue') {
        const issue = repo.issues.get(Number(parsed.parts[2]));
        if (!issue) throw new Error('issue not found');
        const created = store.createComment(repo, issue.number, bodyText);
        if (!created) throw new Error('issue not found');
        subject = issueSource(repo, issue);
        comment = { __typename: 'IssueComment', id: globalId('IssueComment', repo.owner, repo.name, issue.number, created.id), databaseId: created.id, body: created.body, createdAt: created.createdAt, updatedAt: created.createdAt, author: userSource() };
      } else if (parsed.kind === 'PullRequest') {
        const pull = repo.pulls.get(Number(parsed.parts[2]));
        if (!pull) throw new Error('pull request not found');
        const created = store.createComment(repo, pull.number, bodyText);
        if (!created) throw new Error('pull request not found');
        subject = pullSource(repo, pull);
        comment = { __typename: 'IssueComment', id: globalId('IssueComment', repo.owner, repo.name, pull.number, created.id), databaseId: created.id, body: created.body, createdAt: created.createdAt, updatedAt: created.createdAt, author: userSource() };
      } else {
        throw new Error('subjectId must identify an issue or pull request');
      }
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: comment, cursor: encodeCursor(0) },
        subject,
        clientMutationId: (input.clientMutationId as string) ?? null,
      };
    },
  },
  Repository: {
    issue: (source, args) => {
      const repo = source.__repo!;
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueSource(repo, issue) : null;
    },
    issues: (source, args) => {
      const repo = source.__repo!;
      let issues = [...repo.issues.values()];
      const states = (args.states as string[] | undefined) ?? [];
      if (states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const sorted = sortIssues(issues, args.orderBy as { field?: string; direction?: string } | undefined);
      return connection(sorted.map((issue) => issueSource(repo, issue)), args as ConnectionArgs);
    },
    pullRequest: (source, args) => {
      const repo = source.__repo!;
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullSource(repo, pull) : null;
    },
    pullRequests: (source, args) => {
      const repo = source.__repo!;
      let pulls = [...repo.pulls.values()];
      const states = (args.states as string[] | undefined) ?? [];
      if (states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toUpperCase()));
        pulls = pulls.filter((pull) => wanted.has(pull.state.toUpperCase()) || (wanted.has('MERGED') && pull.merged));
      }
      const sorted = sortPulls(pulls, args.orderBy as { field?: string; direction?: string } | undefined);
      return connection(sorted.map((pull) => pullSource(repo, pull)), args as ConnectionArgs);
    },
    defaultBranchRef: (source) => {
      const repo = source.__repo!;
      const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!sha) return null;
      return { __typename: 'Ref', id: globalId('Ref', repo.owner, repo.name, repo.defaultBranch), name: repo.defaultBranch, target: { __typename: 'Commit', oid: sha } };
    },
    owner: (source) => source.owner,
    id: (source) => source.id,
    databaseId: (source) => source.databaseId,
  },
  Issue: {
    labels: (source, args) => {
      const repo = source.__repo!;
      const names = (source.labels as string[]) ?? [];
      const labels = names.map((name) => repo.labels.get(name)).filter((l): l is NonNullable<typeof l> => l !== undefined);
      const first = typeof args.first === 'number' ? args.first : labels.length;
      const page = labels.slice(0, first);
      return {
        __typename: 'LabelConnection',
        nodes: page.map((label) => ({ __typename: 'Label', id: globalId('Label', repo.owner, repo.name, label.name), databaseId: label.id, name: label.name, color: label.color, description: label.description })),
        edges: page.map((label, i) => ({ __typename: 'LabelEdge', node: { __typename: 'Label', id: globalId('Label', repo.owner, repo.name, label.name), databaseId: label.id, name: label.name, color: label.color, description: label.description }, cursor: encodeCursor(i) })),
        totalCount: labels.length,
        pageInfo: { __typename: 'PageInfo', hasNextPage: first < labels.length, hasPreviousPage: false, startCursor: page.length > 0 ? encodeCursor(0) : null, endCursor: page.length > 0 ? encodeCursor(page.length - 1) : null },
      };
    },
    comments: (source, args) => {
      const repo = source.__repo!;
      const number = source.number as number;
      const comments = repo.comments.get(number) ?? [];
      const first = typeof args.first === 'number' ? args.first : comments.length;
      const page = comments.slice(0, first);
      const nodes = page.map((c) => ({ __typename: 'IssueComment', id: globalId('IssueComment', repo.owner, repo.name, number, c.id), databaseId: c.id, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, author: userSource() }));
      return {
        __typename: 'IssueCommentConnection',
        nodes,
        edges: nodes.map((node, i) => ({ __typename: 'IssueCommentEdge', node, cursor: encodeCursor(i) })),
        totalCount: comments.length,
        pageInfo: { __typename: 'PageInfo', hasNextPage: first < comments.length, hasPreviousPage: false, startCursor: nodes.length > 0 ? encodeCursor(0) : null, endCursor: nodes.length > 0 ? encodeCursor(nodes.length - 1) : null },
      };
    },
    repository: (source) => (source.__repo ? repoSource(source.__repo) : null),
    author: (source) => source.author,
  },
  PullRequest: {
    files: (source, args) => {
      const files = (source.files as ReturnType<typeof store.pullFiles>) ?? [];
      const first = typeof args.first === 'number' ? args.first : files.length;
      const page = files.slice(0, first);
      const nodes = page.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED' }));
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes,
        edges: nodes.map((node, i) => ({ __typename: 'PullRequestChangedFileEdge', node, cursor: encodeCursor(i) })),
        totalCount: files.length,
        pageInfo: { __typename: 'PageInfo', hasNextPage: first < files.length, hasPreviousPage: false, startCursor: nodes.length > 0 ? encodeCursor(0) : null, endCursor: nodes.length > 0 ? encodeCursor(nodes.length - 1) : null },
      };
    },
    repository: (source) => (source.__repo ? repoSource(source.__repo) : null),
    author: (source) => source.author,
  },
  __Type: {
    fields: (source, args) => {
      const includeDeprecated = args.includeDeprecated === true;
      void includeDeprecated;
      return (source.fields as unknown[]) ?? [];
    },
    enumValues: (source) => (source.enumValues as unknown[]) ?? [],
  },
};

// Generic field resolution: a source's own properties win; otherwise the type's resolver table.
function resolveField(typeName: string, source: Source, fieldName: string, args: Record<string, unknown>): unknown {
  const table = RESOLVERS[typeName];
  if (table && table[fieldName]) return table[fieldName](source, args);
  if (fieldName in source) return source[fieldName];
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

interface GraphQLError {
  message: string;
  path?: Array<string | number>;
}

function executeSelections(
  typeName: string,
  source: Source,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
  errors: GraphQLError[],
  path: Array<string | number>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = fragments.get(selection.name);
      if (!fragment) {
        errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition && fragment.typeCondition !== typeName && fragment.typeCondition !== source.__typename) {
        // A fragment on another type does not apply.
        continue;
      }
      Object.assign(result, executeSelections(typeName, source, fragment.selections, variables, fragments, errors, path));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition && selection.typeCondition !== typeName && selection.typeCondition !== source.__typename) {
        continue;
      }
      Object.assign(result, executeSelections(typeName, source, selection.selections, variables, fragments, errors, path));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const fieldPath = [...path, responseKey];
    const args: Record<string, unknown> = {};
    for (const [name, node] of Object.entries(selection.args)) args[name] = resolveValue(node, variables);
    let value: unknown;
    try {
      value = resolveField(typeName, source, selection.name, args);
    } catch (err) {
      errors.push({ message: (err as Error).message, path: fieldPath });
      result[responseKey] = null;
      continue;
    }
    if (value === undefined) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".`, path: fieldPath });
      result[responseKey] = null;
      continue;
    }
    if (selection.selections) {
      value = resolveSubSelections(value, selection.selections, variables, fragments, errors, fieldPath);
    }
    result[responseKey] = value;
  }
  return result;
}

function resolveSubSelections(
  value: unknown,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
  errors: GraphQLError[],
  path: Array<string | number>,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, i) => resolveSubSelections(item, selections, variables, fragments, errors, [...path, i]));
  }
  if (typeof value === 'object') {
    const source = value as Source;
    const typeName = source.__typename ?? 'Object';
    return executeSelections(typeName, source, selections, variables, fragments, errors, path);
  }
  return value;
}

export interface GraphQLResponse {
  data?: Record<string, unknown> | null;
  errors?: GraphQLError[];
}

function executeOperation(
  operation: OperationNode,
  variables: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
): GraphQLResponse {
  const errors: GraphQLError[] = [];
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: Source = { __typename: rootType };
  const data = executeSelections(rootType, root, operation.selections, variables, fragments, errors, []);
  const response: GraphQLResponse = { data };
  if (errors.length > 0) response.errors = errors;
  return response;
}

/** Execute one GraphQL request body (a single operation or a batched array). */
export function handleGraphQL(body: unknown): GraphQLResponse | GraphQLResponse[] {
  const runOne = (request: unknown): GraphQLResponse => {
    const req = (request ?? {}) as { query?: string; variables?: Record<string, unknown>; operationName?: string };
    if (typeof req.query !== 'string') {
      return { data: null, errors: [{ message: 'A query string is required.' }] };
    }
    let definitions: DefinitionNode[];
    try {
      definitions = new Parser(req.query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: (err as Error).message }] };
    }
    const fragments = new Map<string, FragmentNode>();
    const operations: OperationNode[] = [];
    for (const def of definitions) {
      if (def.kind === 'fragment') fragments.set(def.name, def);
      else operations.push(def);
    }
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'No operation found in document.' }] };
    }
    let operation = operations[0]!;
    if (req.operationName) {
      const named = operations.find((op) => op.name === req.operationName);
      if (named) operation = named;
    }
    const variables: Record<string, unknown> = { ...(req.variables ?? {}) };
    for (const def of operation.variables) {
      if (!(def.name in variables) && def.defaultValue) variables[def.name] = resolveValue(def.defaultValue, variables);
    }
    try {
      return executeOperation(operation, variables, fragments);
    } catch (err) {
      return { data: null, errors: [{ message: (err as Error).message }] };
    }
  };
  if (Array.isArray(body)) return body.map(runOne);
  return runOne(body);
}
