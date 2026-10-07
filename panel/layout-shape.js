'use strict';
/* The layout file's shape: what a valid file looks like, and the small normalisation applied
   every time it is read. Pure logic, kept out of main.js so it can be tested.

   The window and the list of known projects are global; everything else belongs to one
   project and lives under `projectState[<project path>]`. */

/** Makes sure the per-project table exists and the open project is in the known-projects list. */
function normalizeLayout(d) {
  if (!d || typeof d !== 'object') return d;
  if (!d.projectState) d.projectState = {};
  if (d.project && !Array.isArray(d.projects)) d.projects = [d.project];
  if (Array.isArray(d.projects) && d.project && !d.projects.includes(d.project)) d.projects.push(d.project);
  return d;
}

function layoutValid(d) {
  const object = x => x && typeof x === 'object' && !Array.isArray(x);
  if (!object(d)) return false;
  if (d.project != null && typeof d.project !== 'string') return false;
  if (d.projects != null && (!Array.isArray(d.projects) || d.projects.some(p => typeof p !== 'string'))) return false;
  if (d.projectState != null && (!object(d.projectState) || Object.values(d.projectState).some(p =>
    !object(p) || (p.pages != null && (!Array.isArray(p.pages) || p.pages.some(s => !object(s))))))) return false;
  if (d.window != null && !object(d.window)) return false;
  // An unknown theme does not throw the whole layout away: the theme module falls back to a
  // safe default. Only the field's type is checked here.
  if (d.theme != null && typeof d.theme !== 'string') return false;
  if (d.handoverFile != null && typeof d.handoverFile !== 'string') return false;
  return true;
}
module.exports = { normalizeLayout, layoutValid };
