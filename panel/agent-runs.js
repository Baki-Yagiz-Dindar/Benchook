// SUB-AGENT READER.
//
// DESIGN NOTE 1 - agent records are NOT in the main session file.
// There are ZERO `isSidechain:true` records inside the main.jsonl (counted). Every agent call is
// written into its own folder:
//         agent-<id>.jsonl       -> the whole run of the agent
// So the logic of the context reader, the.jsonl files in a folder, does not work here.
//
// DESIGN NOTE 2 - the THINKING of an agent is not on disk.
// `thinking` blocks are in the record but their contents are empty; only the `signature` is kept.
// The panel therefore cannot say what an agent thought. What it can say is what it RETURNED (the
// last text) and which tool it used against which target.
// Rather than invent what is not there, it is not shown - safety contract.
//
// DESIGN NOTE 3 - Codex writes no structural start or end record for a delegated call.
// (The word subagent appears in the files but inside free text; task_started and task_complete mark
//  the boundary of the OWN turn of Codex, not a delegated agent. Measured.)
// This indicator therefore works only for Claude panes. In a Codex pane, rather than showing an
// empty box, it says that Codex keeps no sub-agent record.

const fs = require('node:fs');
const path = require('node:path');

/* Cache records only while size and modification time are unchanged. A completed or estimated state does not freeze a file; later activity must remain visible. */
const cache = new Map();

/* File timestamps can have coarse resolution. Recheck records modified within the clock margin even if size and mtime match, so same-tick writes are not missed. */
const TICK_MARGIN_MS = 32;

const read = (y) => { try { return fs.readFileSync(y, 'utf8'); } catch { return null; } };
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

function agentFolder(sessionFile) {
  // <...>/<session-id>.jsonl  ->  <...>/<session-id>/subagents
  if (!sessionFile) return null;
  return path.join(path.dirname(sessionFile),
                   path.basename(sessionFile, '.jsonl'), 'subagents');
}

/* * Summarises the.jsonl of one agent. This is the heavy part; the cache is what protects it. */
function summarize(jsonlPath, meta) {
  const raw = read(jsonlPath);
  if (raw === null) return null;
  const lines = raw.split('\n');

  const tools = {};
  const targets = [];
  const flow = [];   // the work of the agent step by step, so it can stream on screen
  let model = null, startedAt = null, updatedAt = null, result = '', step = 0;
  let calls = 0, entry = 0, output = 0, createObj = 0, readObj = 0;

  for (const s of lines) {
    if (!s) continue;
    const k = parse(s);
    if (!k) continue;
    if (k.timestamp) { if (!startedAt) startedAt = k.timestamp; updatedAt = k.timestamp; }
    const m = k.message;
    // TOKENS -- every API call has its own usage block. Input, output and cache are kept SEPARATE:
    // they are priced differently, and adding them up would produce an invented unit. What it writes
    // and what it reads are shown separately.
    const u = m && m.usage;
    if (u) {
      calls++;
      entry  += u.input_tokens || 0;
      output  += u.output_tokens || 0;
      createObj += u.cache_creation_input_tokens || 0;
      readObj  += u.cache_read_input_tokens || 0;
    }
    if (!m || !Array.isArray(m.content)) continue;
    if (m.model) model = m.model;
    for (const p of m.content) {
      if (p.type === 'tool_use') {
        step++;
        tools[p.name] = (tools[p.name] || 0) + 1;
        const g = p.input || {};
        const target = g.file_path || g.pattern || g.command || g.path || g.url || '';
        targets.push({ tool: p.name, target: String(target).slice(0, 160) });
        flow.push({ tip: 'tool', tool: p.name, target: String(target).slice(0, 220), time: k.timestamp || null });
      } else if (p.type === 'text' && k.type === 'assistant' && p.text && p.text.trim()) {
        result = p.text;   // the last one wins = what the agent returned
        flow.push({ tip: 'text', text: p.text.slice(0, 1200), time: k.timestamp || null });
      }
    }
  }

  // Half of the finished marker: when a run ends, the last record is an assistant record carrying
  // only text. That alone is not enough - measured: in two of six agents such a record also appeared
  // in the MIDDLE of the run (three times and once). The other half is inside list.
  let lastRecord = null;
  for (let i = lines.length - 1; i >= 0 && !lastRecord; i--) if (lines[i]) lastRecord = parse(lines[i]);
  const inner = lastRecord && lastRecord.type === 'assistant' && lastRecord.message && lastRecord.message.content;
  const onlyText = !!(Array.isArray(inner) && inner.length && inner.every((x) => x.type === 'text'));

  return {
    onlyText,
    name: meta.agentType || '?',
    task: meta.description || '',
    id: meta.toolUseId || null,
    depth: meta.spawnDepth || 1,
    model, startedAt, updatedAt, step, tools,
    tokens: { calls, output, input: entry + createObj + readObj, present: calls > 0 },
    targets: targets.slice(-12),
    flow: flow.slice(-200),   // the last 200 events; on a long run the beginning drops off
    result,
  };
}

/* Completion requires a task notification matching the agent toolUseId and completed status. A launch tool_result is not completion. Notifications can appear in user or queue-operation records; match their tag content and agent identifier. */
/* Cache completion markers for active and historical sessions using size, modification time, and the clock margin. Closed sessions still need completion information in history. */
const finishedCache = new Map();

function finished(sessionFile) {
  let size = -1, change = 0;
  try { const d = fs.statSync(sessionFile); size = d.size; change = d.mtimeMs; } catch { return null; }
  const old = finishedCache.get(sessionFile);
  if (old && old.trusted && old.size === size && old.change === change) return old.set;
  /* ONLY THE NEW PART OF A GROWING SESSION IS READ. A session file only grows; the whole file used to
     be read again on every 1.2-second round while the user chatted, a cost that grew with the session.
     When the file grew, the scan starts a little before the old end (a marker sits within 600 bytes of
     its id), and the earlier findings are kept. A file that shrank or was replaced is read whole. */
  const OVERLAP = 700;
  const grew = old && old.set && size > old.size;
  const from = grew ? Math.max(0, old.size - OVERLAP) : 0;
  let raw;
  if (from > 0) {
    let fd;
    try {
      fd = fs.openSync(sessionFile, 'r');
      const buffer = Buffer.alloc(size - from);
      const got = fs.readSync(fd, buffer, 0, buffer.length, from);
      raw = buffer.subarray(0, got).toString('utf8');
    } catch { raw = null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
  } else raw = read(sessionFile);
  if (raw === null) return null;
  const set = from > 0 ? new Set(old.set) : new Set();
  /* EVERY WAY A SUBAGENT CAN END. Only "completed" used to count, so a subagent the user stopped (Esc),
     or one that failed or was killed, stayed "Running" on its card for good. The other values were read
     from real Claude Code session files (stopped, failed, killed - in the same notification shape). */
  set.endedAs = from > 0 && old.set.endedAs ? new Map(old.set.endedAs) : new Map();
  const pattern = new RegExp('<tool-use-id>(toolu_[A-Za-z0-9]+)<' + '/tool-use-id>', 'g');
  const statusPattern = new RegExp('<status>(completed|failed|stopped|killed)<' + '/status>');
  let m;
  while ((m = pattern.exec(raw)) !== null) {
    const status = statusPattern.exec(raw.slice(m.index, m.index + 600));
    if (!status) continue;
    if (status[1] === 'completed') set.add(m[1]);
    else set.endedAs.set(m[1], status[1]);
  }
  // If the notification shape is absent altogether (another version), the fallback marker is used.
  set.hasFormat = (from > 0 && old.set.hasFormat) || raw.indexOf('</tool-use-id>') >= 0;
  finishedCache.set(sessionFile, { size, change, set,
    trusted: (Date.now() - change) > TICK_MARGIN_MS });
  // Bounded: the app runs for days; the oldest entry goes once the map holds 200.
  while (finishedCache.size > 200) finishedCache.delete(finishedCache.keys().next().value);
  return set;
}

/** Every agent in the session of a pane, newest first.
 *  The step list of each agent is returned too: on screen each agent streams its OWN card. */
function list(sessionFile, endMarker = true) {
  const folder = agentFolder(sessionFile);
  if (!folder || !fs.existsSync(folder)) return [];

  let signIns;
  try { signIns = fs.readdirSync(folder); } catch { return []; }

  const agents = [];
  let hasUnfinished = false;

  for (const name of signIns) {
    if (!name.endsWith('.meta.json')) continue;
    const root = name.slice(0, -'.meta.json'.length);
    const metaPath = path.join(folder, name);
    const jsonlPath = path.join(folder, root + '.jsonl');

    const meta = parse(read(metaPath) || '');
    if (!meta) continue;

    let size = 0, change = 0;
    try { const d = fs.statSync(jsonlPath); size = d.size; change = d.mtimeMs; }
    catch { size = -1; }   // no.jsonl yet: the agent was just born

    const old = cache.get(jsonlPath);
    const unchanged = !!(old && old.digest && old.trusted && old.size === size && old.change === change);
    let digest;
    if (unchanged) {
      digest = old.digest;                       // neither grown nor changed: no re-parse
    } else if (size > 0) {
      digest = summarize(jsonlPath, meta);
    }

    if (!digest) {
      // The record does not exist yet but the metadata does: the agent was called and has not started writing.
      digest = { name: meta.agentType || '?', task: meta.description || '', id: meta.toolUseId || null,
               depth: meta.spawnDepth || 1, model: null, startedAt: null, updatedAt: null,
               step: 0, tools: {}, targets: [], result: '', onlyText: false, flow: [],
               tokens: { calls: 0, output: 0, input: 0, present: false } };
    }

    const createdAt = (() => { try { return fs.statSync(metaPath).mtimeMs; } catch { return 0; } })();
    /* A CERTAIN end is carried over, an ESTIMATED one is not. The estimate is recomputed every round:
       it drops if the record grows, and it gives way as soon as the real marker in the main record
       becomes visible. If the record changed, a certain marker drops too - a resumed task may be
       running again; if the notification is still there on the next scan it becomes certain again. */
    const record = { file: root, size, change, createdAt, digest,
      trusted: size <= 0 || (Date.now() - change) > TICK_MARGIN_MS,
      end: (unchanged && old && old.end === 'certain') ? 'certain' : null };
    if (record.end !== 'certain') hasUnfinished = true;
    agents.push(record);
    cache.set(jsonlPath, record);
  // Bounded: the app runs for days; the oldest entry goes once the map holds 2000.
  while (cache.size > 2000) cache.delete(cache.keys().next().value);
  }

  // The main record is scanned ONLY while an unfinished agent exists - no reading for nothing.
  // THE FALLBACK MARKER, used only when the notification shape is nowhere to be found: if the last
  // record is an assistant record carrying only text, the agent counts as finished. Its weakness is
  // measured and not hidden - in two of six agents such a record also occurred in the MIDDLE of the
  // run (three times and once), so it can give a short-lived false finished. That is why it is a
  // fallback; the real marker is the notification above.
  if (hasUnfinished && endMarker) {
    const completed = finished(sessionFile);
    if (completed) {
      for (const a of agents) {
        if (a.end === 'certain') continue;
        /* Prefer an explicit completion notification over the text-only fallback estimate. */
        if (completed.hasFormat) {
          if (a.digest.id && completed.has(a.digest.id)) a.end = 'certain';
          else if (a.digest.id && completed.endedAs && completed.endedAs.has(a.digest.id)) {
            a.end = 'certain'; a.outcome = completed.endedAs.get(a.digest.id);
          }
        } else if (a.digest.onlyText) {
          a.end = 'estimated';
        }
        cache.set(path.join(folder, a.file + '.jsonl'), a);
      }
    }
  }

  return agents
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((a) => ({
      file: a.file,
      createdAt: a.createdAt,
      name: a.digest.name,
      task: a.digest.task,
      model: a.digest.model,
      // If the end marker was not read, 'running' IS NOT WRITTEN: it is unknown. The first of the
      // safety constraints - it does not invent what it does not know. Which state it is in is in projectRuns.
      // failed is a failure; stopped or killed is a cancellation, said neutrally (as for worker runs).
      status: endMarker ? (!a.end ? 'running' : a.outcome === 'failed' ? 'error' : a.outcome ? 'cancelled' : 'done') : 'unknown',
      /* WHERE THE END IS KNOWN FROM. 'certain' comes from the notification in the main
         record; 'estimated' is the fallback marker used only when that notification shape is absent
         altogether, and it can be wrong. The screen must not show the two with the same word. */
      endSource: endMarker ? (a.end || null) : null,
      startedAt: a.digest.startedAt,
      updatedAt: a.digest.updatedAt,
      seconds: (a.digest.startedAt && a.digest.updatedAt)
        ? Math.round((Date.parse(a.digest.updatedAt) - Date.parse(a.digest.startedAt)) / 1000)
        : null,
      step: a.digest.step,
      tokens: a.digest.tokens,
      tools: a.digest.tools,
      targets: a.digest.targets,
      result: a.digest.result,
      flow: a.digest.flow || [],
    }));
}

/* * The runs of EVERY session in the project - for the agent history window.
 *  If an agent was run in a project, it is worth seeing there regardless of which session it came
 *  from. The CARDS on the main screen stay tied to the session: that screen is about what is running
 *  right now, and finished runs from other sessions would drown the live information.
 *
 *  The end marker is now read for EVERY session: `finished` is cached and the record of a closed
 *  session is scanned once. It used to be read only for the active session, so a completed run of a
 *  closed session came back as unknown. It is still never ASSUMED finished: if the marker cannot be
 *  read it stays unknown. */
function projectRuns(projectFolder, enabledSessionFile) {
  const enabledName = enabledSessionFile
    ? path.basename(enabledSessionFile, '.jsonl') : null;
  let signIns;
  try { signIns = fs.readdirSync(projectFolder, { withFileTypes: true }); }
  catch { return []; }

  const output = [];
  for (const o of signIns) {
    if (!o.isDirectory()) continue;
    const enabled = o.name === enabledName;
    const file = path.join(projectFolder, o.name + '.jsonl');
    for (const a of list(file, true)) output.push({ ...a, session: o.name, enabled });
  }
  return output.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

module.exports = { list, agentFolder, projectRuns, finished };
