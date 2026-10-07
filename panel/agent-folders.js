'use strict';
/* Where agent definitions live inside a project. Every module that reads, watches or writes
   agent files takes its folders from here, so a folder is added or dropped in one place. */
const path = require('node:path');
const product = require('./product');

/** The panel's own folder. New agents are created here; only these are announced to the
    orchestrator and run by the worker server. */
const PANEL = product.AGENT_FOLDER;

/** Claude Code's own subagent folder, where the built-in review roles live. The panel lists
    these agents and updates an existing file in place rather than moving it, but does not
    announce or run them. */
const CLAUDE = ['.claude', 'agents'];

/** Every folder whose agents appear in the panel's list, in lookup order. */
const LISTED = [PANEL, CLAUDE];

/** Absolute folder paths for one project. */
const inProject = (project, folders) => folders.map((k) => path.join(project, ...k));

module.exports = { PANEL, CLAUDE, LISTED, inProject };
