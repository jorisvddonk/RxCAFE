/**
 * API Handler Registry
 * 
 * Central module that imports and re-exports all API handlers.
 * Handlers are lazy-loaded for faster startup.
 * 
 * Modules:
 * - session.ts      Session CRUD operations
 * - chat.ts         Chat streaming and messaging
 * - presets.ts     Agent preset management
 * - quickies.ts    Quick-access preset commands
 * - connected-agents.ts  External agent integration
 * - streams.ts      SSE stream endpoints
 */

import type { CoreConfig, AddChunkOptions } from '../../core.js';
import type { Database } from '../../database.js';
import type { SessionStore } from '../../session-store.js';

let config: CoreConfig;
let trustDb: Database;
let sessionStore: SessionStore;

export function initApiHandlers(deps: { config: CoreConfig; trustDb: Database; sessionStore: SessionStore }) {
  config = deps.config;
  trustDb = deps.trustDb;
  sessionStore = deps.sessionStore;
  
  import('./session.js').then(m => m.init({ config, sessionStore }));
  import('./chat.js').then(m => m.init({ config }));
  import('./presets.js').then(m => m.init({ config, trustDb }));
  import('./quickies.js').then(m => m.init({ config, trustDb }));
  // connected-agents and streams don't need init
}

export { handleCreateSession, handleListSessions, handleDeleteSession, handleGetHistory, handleToggleTrust, handleSetUIMode, handleDeleteChunk, handleGetChunkBinary } from './session.js';
export { handleChatStream, handleFetchWeb, handleAddChunk, handleAbort, handleListModels, handleListAgents } from './chat.js';
export { 
  handleRegisterConnectedAgent, 
  handleUnregisterConnectedAgent, 
  handleGetAgentSessions, 
  handleAgentSubscribe, 
  handleAgentUnsubscribe, 
  handleAgentJoin, 
  handleAgentLeave, 
  handleGetSessionConnectedAgents, 
  handleAgentSessionStream, 
  handleAgentProduceChunk 
} from './connected-agents.js';
export { handleSessionStream, handleErrorStream, handleSystemCommand } from './streams.js';
export { handleListPresets, handleCreatePreset, handleGetPreset, handleUpdatePreset, handleDeletePreset, handleCreateSessionFromPreset } from './presets.js';
export { handleListQuickies, handleCreateQuickie, handleGetQuickie, handleUpdateQuickie, handleDeleteQuickie, handleLaunchQuickie } from './quickies.js';
export { handleListTemplates } from './templates.js';
