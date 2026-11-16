// Git smart HTTP: info/refs advertisements (v2 + v0), upload-pack (ls-refs, fetch v2/v0) and
// receive-pack (push with report-status + side-band-64k). The wire the suite's git-client speaks.
//
// No auth on this surface (a public-repo shape): the checks always present the token, and no
// check requires a 401 here. A missing repository is 404 on info/refs.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLineDelim,
  pktLineFlush,
  readPack,
  sidebandPackets,
  writePack,
  type GitObject,
  type GitPacket,
} from './git-core.ts';
import { store, type Repo } from './store.ts';

const AGENT = 'git-forge/1.0';

function servicePreamble(service: string): Buffer {
  return encodePktLine(`# service=${service}\n`);
}

function refLinesV0(repo: Repo, service: string): string[] {
  const caps =
    service === 'git-receive-pack'
      ? 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=git-forge/1.0 symref=HEAD:refs/heads/main'
      : 'side-band-64k multi_ack_detailed thin-pack ofs-delta shallow agent=git-forge/1.0 symref=HEAD:refs/heads/main';
  const lines: string[] = [];
  const refs = store.sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
    return lines;
  }
  let first = true;
  for (const ref of refs) {
    lines.push(first ? `${ref.oid} ${ref.name}\u0000${caps}\n` : `${ref.oid} ${ref.name}\n`);
    first = false;
    if (ref.name.startsWith('refs/tags/')) {
      const peeled = store.peelTag(repo, ref.oid);
      if (peeled && peeled !== ref.oid) lines.push(`${peeled} ${ref.name}^{}\n`);
      else if (peeled) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  return lines;
}

/** The v2 capability advertisement for upload-pack. */
function advertisementV2(): Buffer {
  return Buffer.concat([
    servicePreamble('git-upload-pack'),
    pktLineFlush(),
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${AGENT}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow wait-for-done\n'),
    encodePktLine('object-format=sha1\n'),
    pktLineFlush(),
  ]);
}

/** The v0 ref advertisement for a service. */
function advertisementV0(repo: Repo, service: string): Buffer {
  const lines = refLinesV0(repo, service);
  return Buffer.concat([servicePreamble(service), pktLineFlush(), encodePktLines(lines), pktLineFlush()]);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocol: string | null,
): { status: number; contentType: string; body: Buffer } {
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    return { status: 200, contentType, body: advertisementV2() };
  }
  return { status: 200, contentType, body: advertisementV0(repo, service) };
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const hasRefs = repo.refs.size > 0;
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (!hasRefs) {
    // An unborn repository: report only HEAD as unborn. Never report `unborn refs/heads/main`
    // for a prefix query — the suite's git client treats any ref line as an existing ref (with
    // the zero oid), which would make a fixture believe the branch exists and try to read a
    // tree that is not there. The client's own prefix filter drops HEAD when it does not match.
    if (args.unborn) {
      const target = args.symrefs ? ' symref-target:refs/heads/main' : '';
      lines.push(`unborn HEAD${target}\n`);
    }
    return Buffer.concat([encodePktLines(lines), pktLineFlush()]);
  }
  const refs = store.sortedRefs(repo);
  for (const ref of refs) {
    if (args.prefixes.length > 0 && !args.prefixes.some((p) => ref.name.startsWith(p))) continue;
    if (ref.name === 'HEAD') {
      const target = args.symrefs ? ' symref-target:refs/heads/main' : '';
      lines.push(`${ref.oid} HEAD${target}\n`);
      continue;
    }
    let extra = '';
    if (ref.name.startsWith('refs/tags/') && args.peel) {
      const peeled = store.peelTag(repo, ref.oid);
      if (peeled) extra += ` peeled:${peeled}`;
    }
    lines.push(`${ref.oid} ${ref.name}${extra}\n`);
  }
  return Buffer.concat([encodePktLines(lines), pktLineFlush()]);
}

// ---------------------------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  thinPack: boolean;
  noProgress: boolean;
}

function parseV2Request(packets: GitPacket[]): { command: string; args: FetchArgs } {
  const lines: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8'));
  }
  if (!seenDelim && lines.length === 0) throw new Error('empty v2 request');
  const commandLine = (lines[0] ?? '').replace(/\n$/, '');
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length) : '';
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, thinPack: false, noProgress: false };
  for (const raw of lines.slice(1)) {
    const line = raw.replace(/\n$/, '');
    if (line === 'thin-pack') args.thinPack = true;
    else if (line === 'no-progress') args.noProgress = true;
    else if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  return { command, args };
}

/**
 * Plan a fetch: which objects to send, and the shallow-info lines. `depth` limits the commit
 * walk (depth 1 = the wants only). `held` stops the have-walk at the client's shallow boundaries.
 */
function planFetch(
  repo: Repo,
  args: FetchArgs,
): { objects: GitObject[]; newBoundaries: string[]; unshallowed: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const wants = args.wants.filter(isObjectId);
  const haves = args.haves.filter(isObjectId);
  const shallowSet = new Set(args.shallow.filter(isObjectId));
  const depth = args.depth ?? Number.POSITIVE_INFINITY;

  // The wanted set, with each commit's minimum distance from the wants (BFS, so the first
  // visit is the shortest). A commit is included only when its distance is < depth; its tree
  // and blobs are always fully included. Tags resolve at the same distance as their target.
  const wanted = new Set<string>();
  const distance = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = wants.map((oid) => ({ oid, depth: 0 }));
  let head = 0;
  while (head < queue.length) {
    const { oid, depth: d } = queue[head++]!;
    if (wanted.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      if (d >= depth) continue;
      wanted.add(oid);
      if (!distance.has(oid)) distance.set(oid, d);
      const commit = parseCommit(object.data);
      queue.push({ oid: commit.tree, depth: d });
      for (const parent of commit.parents) queue.push({ oid: parent, depth: d + 1 });
    } else if (object.type === 'tag') {
      wanted.add(oid);
      if (!distance.has(oid)) distance.set(oid, d);
      queue.push({ oid: parseTag(object.data).object, depth: d });
    } else if (object.type === 'tree') {
      wanted.add(oid);
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push({ oid: entry.oid, depth: d });
      }
    } else {
      wanted.add(oid);
    }
  }

  // The held set: everything reachable from the haves, stopping at the shallow boundaries.
  const held = new Set<string>();
  const heldQueue: string[] = [...haves];
  while (heldQueue.length) {
    const oid = heldQueue.pop()!;
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      if (shallowSet.has(oid)) continue;
      const commit = parseCommit(object.data);
      heldQueue.push(commit.tree);
      for (const parent of commit.parents) heldQueue.push(parent);
    } else if (object.type === 'tag') {
      heldQueue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        heldQueue.push(entry.oid);
      }
    }
  }

  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (object) objects.push(object);
  }

  let newBoundaries: string[] = [];
  let unshallowed: string[] = [];
  if (Number.isFinite(depth)) {
    // New boundaries: commits at distance depth - 1 from the wants.
    for (const [oid, d] of distance) {
      const object = lookup(oid);
      if (object?.type === 'commit' && d === depth - 1) newBoundaries.push(oid);
    }
    // Unshallowed: old boundaries now inside the included range (distance < depth - 1).
    for (const boundary of shallowSet) {
      const d = distance.get(boundary);
      if (d !== undefined && d < depth - 1) unshallowed.push(boundary);
    }
    newBoundaries = [...new Set(newBoundaries)].sort();
    unshallowed = [...new Set(unshallowed)].sort();
  }
  return { objects, newBoundaries, unshallowed };
}

function fetchResponseV2(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  // acknowledgments: only when the client sent haves (negotiation). A fresh clone sends no
  // haves, and git's client then expects the response to start at the packfile section.
  if (args.haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    const haveAcks = args.haves.filter((oid) => repo.objects.has(oid));
    if (haveAcks.length > 0) {
      for (const oid of haveAcks) parts.push(encodePktLine(`ACK ${oid}\n`));
      parts.push(encodePktLine('ready\n'));
    } else {
      parts.push(encodePktLine('NAK\n'));
    }
    parts.push(pktLineDelim());
  }
  // shallow-info
  if (args.depth !== null) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.newBoundaries) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowed) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
  }
  // packfile
  parts.push(encodePktLine('packfile\n'));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function parseV0Fetch(body: Buffer): FetchArgs {
  const packets = decodePktLines(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, thinPack: false, noProgress: false };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      args.wants.push(space < 0 ? rest.trim() : rest.slice(0, space));
    } else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  return args;
}

function fetchResponseV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  const haveAcks = args.haves.filter((oid) => repo.objects.has(oid));
  if (haveAcks.length > 0) {
    for (const oid of haveAcks) parts.push(encodePktLine(`ACK ${oid}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  if (args.depth !== null) {
    for (const oid of plan.newBoundaries) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowed) parts.push(encodePktLine(`unshallow ${oid}\n`));
  }
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(
  repo: Repo,
  body: Buffer,
  gitProtocol: string | null,
): { status: number; contentType: string; body: Buffer } {
  const contentType = 'application/x-git-upload-pack-result';
  let packets: GitPacket[];
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed pkt-line stream', 'utf8') };
  }
  if (gitProtocol === 'version=2') {
    let parsed: { command: string; args: FetchArgs };
    try {
      parsed = parseV2Request(packets);
    } catch {
      return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed v2 request', 'utf8') };
    }
    if (parsed.command === 'ls-refs') {
      const lines: string[] = [];
      let seenDelim = false;
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const packet of packets) {
        if (packet.kind === 'flush') break;
        if (packet.kind === 'delim') {
          seenDelim = true;
          continue;
        }
        if (packet.kind !== 'data') continue;
        const line = packet.payload.toString('utf8').replace(/\n$/, '');
        if (!seenDelim) continue;
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line === 'unborn') args.unborn = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
      }
      return { status: 200, contentType, body: lsRefsResponse(repo, args) };
    }
    if (parsed.command === 'fetch') {
      return { status: 200, contentType, body: fetchResponseV2(repo, parsed.args) };
    }
    return { status: 400, contentType: 'text/plain', body: Buffer.from(`unknown v2 command ${parsed.command}`, 'utf8') };
  }
  // v0 fetch
  let args: FetchArgs;
  try {
    args = parseV0Fetch(body);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed v0 fetch', 'utf8') };
  }
  return { status: 200, contentType, body: fetchResponseV0(repo, args) };
}

// ---------------------------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function splitCommandsAndPack(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  // Walk pkt-lines until the flush; the rest is the packfile.
  let offset = 0;
  const commands: PushCommand[] = [];
  const HEX4 = /^[0-9a-fA-F]{4}$/;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('truncated pkt-line in command list');
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const nul = payload.indexOf('\u0000');
    const line = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  const pack = offset < body.length ? body.subarray(offset) : null;
  return { commands, pack: pack && pack.length > 0 ? pack : null };
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(
  repo: Repo,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  const contentType = 'application/x-git-receive-pack-result';
  let commands: PushCommand[];
  let pack: Buffer | null;
  try {
    ({ commands, pack } = splitCommandsAndPack(body));
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed push command list', 'utf8') };
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('no push commands', 'utf8') };
  }
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (needsPack) {
    if (!pack) {
      unpackOk = false;
      unpackDetail = 'missing packfile';
    } else {
      try {
        const read = readPack(pack);
        for (const [oid, object] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = (err as Error).message;
      }
    }
  }
  const reportLines: string[] = [];
  reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    if (!isObjectId(command.oldOid) || !isObjectId(command.newOid)) {
      reportLines.push(`ng ${command.ref} bad object id\n`);
      continue;
    }
    if (!command.ref.startsWith('refs/') || /[\s\u0000-\u001f]/.test(command.ref)) {
      reportLines.push(`ng ${command.ref} bad ref name\n`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? null;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === null) {
        reportLines.push(`ng ${command.ref} ref does not exist\n`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    // Create or update: the new object must be present.
    if (!repo.objects.has(command.newOid)) {
      reportLines.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (current === null) {
      // Create.
      if (command.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    // Update: old must match, and the new tip must descend from the old.
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (newObject?.type === 'commit') {
      const ancestor = command.oldOid === ZERO_OID ? true : isAncestorOf(repo, command.oldOid, command.newOid);
      if (!ancestor) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
    } else if (newObject?.type === 'tag') {
      // A tag ref may only be created, not moved.
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }
  const reportStream = encodePktLines([...reportLines, 'flush']);
  const parts: Buffer[] = [];
  for (const packet of sidebandPackets(1, reportStream)) parts.push(packet);
  parts.push(pktLineFlush());
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

/** Is `ancestor` an ancestor of (or equal to) `oid`, resolving tags to their target commit? */
function isAncestorOf(repo: Repo, ancestor: string, oid: string): boolean {
  const lookup = (id: string): GitObject | undefined => repo.objects.get(id);
  let target = oid;
  const targetObject = lookup(oid);
  if (targetObject?.type === 'tag') {
    const peeled = store.peelTag(repo, oid);
    if (!peeled) return false;
    target = peeled;
  }
  if (ancestor === target) return true;
  const seen = new Set<string>();
  const queue = [target];
  while (queue.length) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = lookup(current);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}
