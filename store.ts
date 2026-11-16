// The forge's in-memory store: repositories, git objects + refs, issues, pull requests, labels,
// comments. One Store per process; every surface (git smart HTTP, REST, GraphQL, MCP) reads and
// writes the same objects, so a commit pushed over git is visible over REST and vice versa.
//
// Determinism: no clock, no randomness in stored state. Timestamps are a fixed constant; ids are
// sequential counters. The suite's replay compares pass/fail bits, which derive from this state.

import {
  ZERO_OID,
  buildCommit,
  buildTreeFromPaths,
  buildTree,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
} from './git-core.ts';
import { VIEWER_LOGIN, VIEWER_ID } from './scenario.ts';

export { VIEWER_LOGIN, VIEWER_ID };

export const FIXED_TIMESTAMP = '2026-11-14T06:30:00Z';
export const DEFAULT_BRANCH = 'main';

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  issueNumber: number;
  body: string;
  seq: number;
  createdAt: string;
}

export interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string | null;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
  nextCommentId: number;
}

/** A global (Relay) id: base64url of "<Type>:<databaseId>[:<number>]", opaque and stable. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  const raw = `${kind}:${parts.join(':')}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const raw = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = raw.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  private nextObjectId = 1;
  private nextRepoSeq = 1;

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextObjectId++,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      seq: this.nextRepoSeq++,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      comments: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  // -- git objects -----------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The ref's current tip, or null when the ref does not exist. */
  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  /** All refs, sorted: HEAD first (when it resolves), then refs/heads/*, refs/tags/*, others. */
  sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
    const names = [...repo.refs.keys()].sort();
    const out: Array<{ name: string; oid: string }> = [];
    const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (mainTip) out.push({ name: 'HEAD', oid: mainTip });
    for (const name of names) out.push({ name, oid: repo.refs.get(name)! });
    return out;
  }

  /** The commit a tag ref peels to (its target commit), or null. */
  peelTag(repo: Repo, tagOid: string): string | null {
    const object = repo.objects.get(tagOid);
    if (!object) return null;
    if (object.type === 'commit') return tagOid;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      return this.peelTag(repo, target);
    }
    return null;
  }

  /** The commits reachable from `tip`, newest first (first-parent walk, then other parents). */
  commitList(repo: Repo, tip: string, limit = 1000): Array<{ sha: string; message: string; author: string; committer: string }> {
    const out: Array<{ sha: string; message: string; author: string; committer: string }> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length && out.length < limit) {
      const sha = queue.shift()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const object = repo.objects.get(sha);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha, message: commit.message, author: commit.author, committer: commit.committer });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  /** The tree at a commit, as a flat path map. */
  treePaths(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return new Map();
    return flattenTree(repo.objects.get.bind(repo.objects), parseCommit(object.data).tree);
  }

  /** The blob oid at `path` in the tree of `commitOid`, or null. */
  blobAtPath(repo: Repo, commitOid: string, path: string): { oid: string; mode: string } | null {
    return this.treePaths(repo, commitOid).get(path) ?? null;
  }

  /** Create a commit on `branch` with the given path map, parented on the branch tip (or on
   *  `baseCommit` when the branch does not exist yet, e.g. a contents write creating a branch). */
  commitOnBranch(
    repo: Repo,
    branch: string,
    paths: Map<string, { oid: string; mode: string }>,
    message: string,
    baseCommit?: string | null,
  ): string {
    const parent = repo.refs.get(`refs/heads/${branch}`) ?? baseCommit ?? null;
    const storeFn = (type: GitObjectType, data: Buffer): string => this.putObject(repo, type, data);
    const treeOid = buildTreeFromPaths(repo.objects.get.bind(repo.objects), storeFn, paths);
    const commitData = buildCommit({
      tree: treeOid,
      parents: parent ? [parent] : [],
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const commitOid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return commitOid;
  }

  /** The diff between two trees (flat path maps): changed paths with old/new oids. */
  diffTrees(
    repo: Repo,
    baseCommit: string | null,
    headCommit: string,
  ): Array<{ path: string; oldOid: string | null; newOid: string | null; status: 'added' | 'modified' | 'removed' }> {
    const base = baseCommit ? this.treePaths(repo, baseCommit) : new Map<string, { oid: string; mode: string }>();
    const head = this.treePaths(repo, headCommit);
    const out: Array<{ path: string; oldOid: string | null; newOid: string | null; status: 'added' | 'modified' | 'removed' }> = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const oldEntry = base.get(path);
      const newEntry = head.get(path);
      if (oldEntry && !newEntry) out.push({ path, oldOid: oldEntry.oid, newOid: null, status: 'removed' });
      else if (!oldEntry && newEntry) out.push({ path, oldOid: null, newOid: newEntry.oid, status: 'added' });
      else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
        out.push({ path, oldOid: oldEntry.oid, newOid: newEntry.oid, status: 'modified' });
      }
    }
    return out;
  }

  // -- labels / issues / comments -------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    const label: Label = { name, color, description: '' };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: string } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: `Label '${label}' does not exist` };
    }
    const number = repo.nextNumber++;
    const issue: Issue = {
      number,
      id: this.nextObjectId++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      seq: number,
      createdAt: FIXED_TIMESTAMP,
      updatedAt: FIXED_TIMESTAMP,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  listIssues(repo: Repo, state: 'open' | 'closed' | 'all', sort: 'created' | 'updated', direction: 'asc' | 'desc'): Issue[] {
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    // Creation order is the only order (all timestamps are the fixed constant).
    list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    return list;
  }

  createComment(repo: Repo, issueNumber: number, body: string): Comment | null {
    if (!repo.issues.has(issueNumber)) return null;
    const comment: Comment = {
      id: this.nextObjectId++,
      issueNumber,
      body,
      seq: repo.nextCommentId++,
      createdAt: FIXED_TIMESTAMP,
    };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  // -- pull requests ---------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest | { error: string; status: number } {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha) return { error: `Head branch '${headRef}' does not exist`, status: 422 };
    if (!baseSha) return { error: `Base branch '${baseRef}' does not exist`, status: 422 };
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
        return { error: 'A pull request already exists for this head and base', status: 422 };
      }
    }
    const base = mergeBase(repo.objects.get.bind(repo.objects), baseSha, headSha);
    const number = repo.nextNumber++;
    const pull: PullRequest = {
      number,
      id: this.nextObjectId++,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      mergeBaseSha: base,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: number,
      createdAt: FIXED_TIMESTAMP,
      updatedAt: FIXED_TIMESTAMP,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  listPulls(repo: Repo, state: 'open' | 'closed' | 'all'): PullRequest[] {
    let list = [...repo.pulls.values()];
    if (state !== 'all') list = list.filter((pull) => pull.state === state);
    list.sort((a, b) => b.seq - a.seq);
    return list;
  }

  /** Whether a pull request merges cleanly (no file changed on both sides of the merge-base).
   *  The base side is measured from the merge-base to the base branch's CURRENT tip, so a
   *  conflicting change merged after this pull was opened is still detected. */
  pullConflict(repo: Repo, pull: PullRequest): boolean {
    const base = pull.mergeBaseSha;
    if (!base) return false;
    const headChanges = this.diffTrees(repo, base, pull.headSha);
    const currentBaseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const baseChanges = this.diffTrees(repo, base, currentBaseSha);
    const baseChangedPaths = new Set(baseChanges.map((change) => change.path));
    return headChanges.some((change) => baseChangedPaths.has(change.path));
  }

  pullFiles(repo: Repo, pull: PullRequest): Array<{ filename: string; status: 'added' | 'modified' | 'removed' | 'changed'; additions: number; deletions: number; changes: number }> {
    const changes = this.diffTrees(repo, pull.mergeBaseSha, pull.headSha);
    const out: Array<{ filename: string; status: 'added' | 'modified' | 'removed' | 'changed'; additions: number; deletions: number; changes: number }> = [];
    for (const change of changes) {
      const countLines = (oid: string | null): string[] => {
        if (!oid) return [];
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'blob') return [];
        const text = object.data.toString('utf8');
        return text === '' ? [] : text.split('\n');
      };
      const oldLines = countLines(change.oldOid);
      const newLines = countLines(change.newOid);
      let additions = 0;
      let deletions = 0;
      if (change.status === 'added') additions = newLines.length;
      else if (change.status === 'removed') deletions = oldLines.length;
      else {
        const oldSet = new Set(oldLines);
        const newSet = new Set(newLines);
        additions = newLines.filter((line) => !oldSet.has(line)).length;
        deletions = oldLines.filter((line) => !newSet.has(line)).length;
        if (additions === 0 && deletions === 0) {
          additions = 1;
          deletions = 0;
        }
      }
      const status = change.status === 'modified' ? 'modified' : change.status;
      out.push({ filename: change.path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit oid, or an error. */
  mergePull(repo: Repo, pull: PullRequest, method: string): { sha: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'Pull request is not open', status: 405 };
    if (this.pullConflict(repo, pull)) return { error: 'Merge conflict', status: 405 };
    const base = pull.mergeBaseSha;
    const headChanges = this.diffTrees(repo, base, pull.headSha);
    const basePaths = this.treePaths(repo, pull.baseSha);
    for (const change of headChanges) {
      if (change.newOid === null) basePaths.delete(change.path);
      else basePaths.set(change.path, { oid: change.newOid, mode: '100644' });
    }
    const storeFn = (type: GitObjectType, data: Buffer): string => this.putObject(repo, type, data);
    const treeOid = buildTreeFromPaths(repo.objects.get.bind(repo.objects), storeFn, basePaths);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    let commitOid: string;
    if (method === 'merge') {
      commitOid = this.putObject(
        repo,
        'commit',
        buildCommit({ tree: treeOid, parents: [pull.baseSha, pull.headSha], message }),
      );
    } else {
      commitOid = this.putObject(
        repo,
        'commit',
        buildCommit({ tree: treeOid, parents: [pull.baseSha], message }),
      );
    }
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_TIMESTAMP;
    pull.mergeCommitSha = commitOid;
    pull.updatedAt = FIXED_TIMESTAMP;
    return { sha: commitOid };
  }
}

export const store = new Store();

/** The viewer identity, for REST/GraphQL user objects. */
export function viewerUser(): { login: string; id: number; type: string; name: string; email: string } {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid` };
}
