'use strict';
const path = require('node:path');
const os = require('node:os');
const product = require('./product');

/** The panel's data folder: BENCHOOK_DATA_DIR when set, otherwise the product folder under the user's application data. */
function resolve(env = process.env) {
  if (env.BENCHOOK_DATA_DIR) return path.resolve(env.BENCHOOK_DATA_DIR);
  const root = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(root, product.NAME);
}
module.exports = { resolve };
