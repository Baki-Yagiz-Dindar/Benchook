'use strict';
/* Every name that would change if the product were renamed, in one place.
   Anything derived from the product name belongs here: the user-data folder, the folder the
   panel writes into a project, the temporary folder prefixes, the MCP server name.

   Environment variable names are listed here for reference, but they are still read as
   literals (`process.env.BENCHOOK_SESSION`) at the point of use. They cross process and
   program boundaries -- child terminals, the Codex `env_vars` block, hook arguments -- so a
   reader has to be able to find every use of one by searching for its exact name.

   WHAT THIS MODULE DOES NOT REACH, so a rename is not a single edit here:
   - `panel/panel.js` runs in the renderer and has no module system, so the folder names it
     shows the user are written out in full there;
   - the environment variable names above, for the reason just given;
   - test expectations, which state the names they expect rather than importing them. */

const NAME = 'Benchook';
const SLUG = 'benchook';

module.exports = {
  NAME,
  SLUG,
  /** The product version, from the one place that holds it (`panel/package.json`). Reported to the
      providers and MCP clients this panel talks to; four hand-written copies had drifted apart. */
  VERSION: require('./package.json').version,
  /** Folder the panel creates inside a user's project. */
  PROJECT_FOLDER: '.' + SLUG,
  /** Where the panel writes agent definitions inside a project, as path segments. */
  AGENT_FOLDER: ['.' + SLUG, 'agents'],
  /** Folder-transaction working copies, next to the target folder. */
  STAGING_PREFIX: '.' + SLUG + '-new-',
  BACKUP_PREFIX: '.' + SLUG + '-backup-',
  TRANSACTION_PREFIX: '.' + SLUG + '-transaction-',
  /** Reported to MCP clients in `serverInfo.name`. */
  MCP_SERVER_NAME: SLUG + '-worker',
  /** The key the worker server is registered under, in `.mcp.json` and in Codex `config.toml`.
      Providers name the tools after it (`mcp__benchook__run_agent`) and record calls under it.
      Existing entries are recognised by the script they run, never by this key. */
  MCP_SERVER_KEY: SLUG,
  /** Read as literals at the point of use; see the note above. */
  ENV: {
    DATA_DIR: 'BENCHOOK_DATA_DIR',
    PROJECT: 'BENCHOOK_PROJECT',
    SESSION: 'BENCHOOK_SESSION',
    ORCHESTRATOR_MODEL: 'BENCHOOK_ORCHESTRATOR_MODEL',
    FOLDER: 'BENCHOOK_FOLDER',
  },
};
