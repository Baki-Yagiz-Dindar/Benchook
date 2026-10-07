'use strict';
function stopTerminal(terminal, timeoutMs = 5000) {
  return new Promise(resolve => {
    let finished = false, subscription, timer;
    const finish = result => {
      if (finished) return;
      finished = true; clearTimeout(timer); subscription?.dispose(); resolve(result);
    };
    timer = setTimeout(() => finish({ error: 'Terminal did not stop. The session was preserved; try again.' }), timeoutMs);
    subscription = terminal.onExit(() => finish({ done: true }));
    try { terminal.kill(); }
    catch (error) { finish({ error: 'Could not stop terminal: ' + error.message }); }
  });
}
module.exports = { stopTerminal };
