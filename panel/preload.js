// The only door between the page and the Node side. contextIsolation is on: the page cannot
// reach Node directly, only the functions declared here.

const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('panel', {
  openTerminal: (options) => ipcRenderer.invoke('terminal:open', options),
  writeTerminal:        (id, data)   => ipcRenderer.send('terminal:write', { id, data }),
  resizeTerminal:      (id, s, r)   => ipcRenderer.send('terminal:resize', { id, column: s, line: r }),
  closeTerminal:      (id)         => ipcRenderer.send('terminal:close', { id }),
  closeTerminalAndWait: (id)         => ipcRenderer.invoke('terminal:closeAndWait', { id }),

  onTerminalData:  (f) => ipcRenderer.on('terminal:data',  (_o, y) => f(y)),
  onTerminalExit: (f) => ipcRenderer.on('terminal:exit', (_o, y) => f(y)),

  readContext:  (id) => ipcRenderer.invoke('context:read', { id }),
  readAgents: (id) => ipcRenderer.invoke('agents:read', { id }),
  projectAgentRuns: (project, id) => ipcRenderer.invoke('agents:project', { project, id }),
  projectWorkers: (project) => ipcRenderer.invoke('workers:project', { project }),
  answerWorker: (project, runId, questionId, decision) => ipcRenderer.invoke('workers:answer', { project, runId, questionId, decision }),
  handoverStatus: (project, provider, sessionId, accountId) =>
    ipcRenderer.invoke('handover:status', { project, provider, sessionId, accountId }),
  copySession: (provider, project, sessionId, sourceAccount, targetAccount) =>
    ipcRenderer.invoke('session:copy', { provider, project, sessionId, sourceAccount, targetAccount }),
  pickProject:   ()   => ipcRenderer.invoke('project:pick'),
  listAgents: (project) => ipcRenderer.invoke('agent:list', { project }),
  // Watching for outside changes: the page sets the targets, listens for the event and asks for the file diff.
  setupWatcher:   (project, projects) => ipcRenderer.invoke('watcher:setup', { project, projects }),
  onChange: (f) => ipcRenderer.on('watcher:changed', (_o, y) => f(y)),
  agentFileState: (filePath, previousContent) =>
    ipcRenderer.invoke('agent:fileState', { filePath, previousContent }),
  previewAgent: (project, field) => ipcRenderer.invoke('agent:preview', { project, field }),
  /* ONE OBJECT. With six positional parameters, dropping one silently shifted the rest
     into the wrong fields, and adding the identity (the old name) made the order unreadable. */
  writeAgent:    (request) => ipcRenderer.invoke('agent:write', request),
  // This door now ONLY removes from a project; the agent stays in the registry.
  removeAgent:    (project, filePath) => ipcRenderer.invoke('agent:remove', { project, filePath }),
  scanAgentFolder: (folder) => ipcRenderer.invoke('agent:scanFolder', { folder }),
  importAgentsFromFolder: (folder, names) => ipcRenderer.invoke('agent:importFolder', { folder, names }),
  deleteAgent: (name) => ipcRenderer.invoke('agent:delete', { name }),
  agentRegistry: () => ipcRenderer.invoke('agent:registry'),
  agentConflicts: () => ipcRenderer.invoke('agent:conflicts'),
  renameAgentCopy: (project, oldName, newName, filePath) =>
    ipcRenderer.invoke('agent:renameCopy', { project, oldName, newName, filePath }),
  onboardingPlan: (project, accountId) =>
    ipcRenderer.invoke('onboarding:plan', { project, accountId }),
  applyOnboarding: (project, accountId, selection) =>
    ipcRenderer.invoke('onboarding:apply', { project, accountId, selection }),
  setupPlan:   (project) => ipcRenderer.invoke('setup:plan', { project }),
  applySetup: (steps) => ipcRenderer.invoke('setup:apply', { steps }),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  listAccounts: ()       => ipcRenderer.invoke('accounts:list'),
  accountStatus: ()       => ipcRenderer.invoke('accounts:status'),
  addAccount:  (account)  => ipcRenderer.invoke('accounts:add', { account }),
  cliProblem:  (provider) => ipcRenderer.invoke('cli:problem', { provider }),
  removeAccount:   (id) => ipcRenderer.invoke('accounts:remove', { id }),
  signOut: (id) => ipcRenderer.invoke('accounts:signOut', { id }),
  startSignIn: (id) => ipcRenderer.invoke('accounts:startSignIn', { id }),
  cancelSignIn: (id) => ipcRenderer.invoke('accounts:cancelSignIn', { id }),
  onSignIn: (f) => ipcRenderer.on('account:signIn', (_o, v) => f(v)),
  listSkills: (project) => ipcRenderer.invoke('skill:list', { project }),
  completeSkills: (project) => ipcRenderer.invoke('skill:complete', { project }),
  skillRegistry: (project) => ipcRenderer.invoke('skill:registry', { project }),
  builtinSkills: () => ipcRenderer.invoke('skill:builtins'),
  addSkillToProject: (project, folderName) => ipcRenderer.invoke('skill:addToProject', { project, folderName }),
  deleteSkill: (folderName) => ipcRenderer.invoke('skill:delete', { folderName }),
  importSkill: (project, source, folderName) => ipcRenderer.invoke('skill:import', { project, source, folderName }),
  writeSkill: (project, folderName, content, sourceSide) =>
    ipcRenderer.invoke('skill:write', { project, folderName, content, sourceSide }),
  removeSkill: (project, folderName) => ipcRenderer.invoke('skill:remove', { project, folderName }),
  skillPaths: (project, folderName) => ipcRenderer.invoke('skill:paths', { project, folderName }),
  skillSavePaths: (project, folderName) => ipcRenderer.invoke('skill:savePaths', { project, folderName }),
  suggestAccountFolder:    (provider, name) => ipcRenderer.invoke('accounts:suggestFolder', { provider, name }),
  codexModels: (folder) => ipcRenderer.invoke('accounts:codexModels', { folder }),
  claudeModels: (folder) => ipcRenderer.invoke('accounts:claudeModels', { folder }),
  claudeLatest: (folder) => ipcRenderer.invoke('accounts:claudeLatest', { folder }),
  mcpStatus:     (project, id) => ipcRenderer.invoke('mcp:status', { project, id }),
  setupMcp:       (project, id) => ipcRenderer.invoke('mcp:setup', { project, id }),
  askAgainMcp:    (project) => ipcRenderer.invoke('mcp:askAgain', { project }),

  readLayout:   ()     => ipcRenderer.invoke('layout:read'),
  writeLayoutAndWait: (data) => ipcRenderer.invoke('layout:writeAndWait', data),
  recordSwitchMetric: (record) => ipcRenderer.send('metrics:switch', record),
  reportStall:    (record) => ipcRenderer.send('stall:renderer', record),
  forgetProject:  (filePath)   => ipcRenderer.invoke('layout:forgetProject', { filePath }),

  readClipboard:    ()      => clipboard.readText(),
  writeClipboard:    (text) => clipboard.writeText(text),
  openLink: (url)   => ipcRenderer.send('link:open', { url }),
});
