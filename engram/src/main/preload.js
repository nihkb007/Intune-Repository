'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('engram', {
  init: call('app:init'),
  scan: call('scan:run'),
  sessionDetail: call('session:detail'),
  sessionReplay: call('session:replay'),
  notes: { list: call('notes:list'), upsert: call('notes:upsert'), remove: call('notes:delete') },
  fusion: { create: call('fusion:create'), inject: call('fusion:inject'), remove: call('fusion:delete'), export: call('fusion:export') },
  accounts: { detect: call('accounts:detect'), upsert: call('accounts:upsert'), remove: call('accounts:remove'), setActive: call('accounts:setActive') },
  bridge: { plan: call('bridge:plan'), sync: call('bridge:sync'), memory: call('bridge:memory') },
  launch: { terminal: call('launch:terminal'), command: call('launch:command') },
  settings: { update: call('settings:update') },
  drive: { status: call('drive:status'), share: call('drive:share'), unshare: call('drive:unshare'), choose: call('drive:choose'), dismiss: call('drive:dismiss'), diskManagement: call('drive:diskManagement') },
  sync: { status: call('sync:status'), update: call('sync:update'), now: call('sync:now'), bringHere: call('sync:bringHere') },
  clipboard: call('clipboard:write'),
  openPath: call('shell:openPath'),
  pickFolder: call('dialog:pickFolder'),
  win: { minimize: call('win:minimize'), maximize: call('win:maximize'), close: call('win:close') },
  onModel: (fn) => ipcRenderer.on('model:update', (_e, m) => fn(m)),
});
