'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
// Start-Process flattens ArgumentList; quote for the Windows native argument parser.
function quote(value) {
  return '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
function command(executable, args) {
  const literal = value => "'" + value.replace(/'/g, "''") + "'";
  return "$ErrorActionPreference='Stop'; try { $loginProcess=Start-Process -FilePath "
    + literal(executable) + ' -ArgumentList ' + literal(args.map(quote).join(' '))
    + ' -WindowStyle Normal -Wait -PassThru; exit $loginProcess.ExitCode } catch { exit 1 }';
}
function start(c, args, env) {
  if (process.platform !== 'win32') throw new Error('Native sign-in currently requires Windows');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return spawn(executable, ['-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(command(c.command,[...c.leadingArgs,...args]),'utf16le').toString('base64')],
  {env, windowsHide:true, stdio:'ignore'});
}
module.exports={start,command,quote};
