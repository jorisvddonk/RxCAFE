/**
 * RXCAFE Agent Loader
 * Auto-discovers and loads agent definitions from agents/*.ts
 */

import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import type { AgentDefinition } from './agent.js';
import { reloadSessionAgent, getCoreConfig } from '../core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const agents = new Map<string, AgentDefinition>();
const loadedAgentFiles = new Set<string>();
const agentSourceHashes = new Map<string, string>();
const agentNameToFile = new Map<string, string>();
let loaded = false;

function computeFileHash(filePath: string): string {
  const content = readFileSync(filePath, 'utf-8');
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

export function loadAgents(forceReload = false): Map<string, AgentDefinition> {
  if (loaded && !forceReload) {
    return agents;
  }
  
  const searchPaths: string[] = [];
  
  // 1. Add default agents directory
  const defaultDir = join(__dirname, '..', 'agents');
  if (existsSync(defaultDir)) {
    searchPaths.push(defaultDir);
  }

  // 2. Add paths from environment variable
  const envPaths = process.env.RXCAFE_AGENT_SEARCH_PATHS;
  if (envPaths) {
    const paths = envPaths.split(':').map(p => resolve(p.trim())).filter(p => p.length > 0);
    searchPaths.push(...paths);
  }

  if (searchPaths.length === 0) {
    console.log(`[AgentLoader] No agent directories found.`);
    loaded = true;
    return agents;
  }

  // Clear module cache for agent files if force reloading
  if (forceReload) {
    for (const file of loadedAgentFiles) {
      delete require.cache[file];
      const url = 'file://' + file;
      delete (globalThis as any).Bun?.registry?.get(url);
    }
    loadedAgentFiles.clear();
  }

  for (const dir of searchPaths) {
    if (!existsSync(dir)) {
      console.log(`[AgentLoader] Directory not found: ${dir}`);
      continue;
    }

    console.log(`[AgentLoader] Scanning directory for agents: ${dir}`);
    
    try {
      const files = readdirSync(dir)
        .filter(f => f.endsWith('.ts'))
        .map(f => join(dir, f));
      
      for (const file of files) {
        try {
          // Use require() to force re-execution on reload (unlike import() which caches)
          let module: any;
          if (forceReload) {
            // Clear require cache for this file
            delete require.cache[require.resolve(file)];
          }
          module = require(file);
          loadedAgentFiles.add(file);
          
          // Update source hash
          const newHash = computeFileHash(file);
          agentSourceHashes.set(file, newHash);
          
          // Check named exports first
          for (const exportName of Object.keys(module)) {
            if (exportName === 'default') continue;
            
            const exported = module[exportName];
            
            if (isAgentDefinition(exported)) {
              agents.set(exported.name, exported);
              agentNameToFile.set(exported.name, file);
              console.log(`[AgentLoader] Loaded agent: ${exported.name}${exported.startInBackground ? ' (background)' : ''} from ${file}`);
            }
          }
          
          // Then check default export if no named agent was found
          if (module.default && isAgentDefinition(module.default)) {
            agents.set(module.default.name, module.default);
            agentNameToFile.set(module.default.name, file);
            console.log(`[AgentLoader] Loaded agent: ${module.default.name}${module.default.startInBackground ? ' (background)' : ''} from ${file}`);
          }
        } catch (err) {
          console.error(`[AgentLoader] Failed to load ${file}:`, err);
        }
      }
    } catch (err) {
      console.error(`[AgentLoader] Failed to scan directory ${dir}:`, err);
    }
  }
  
  loaded = true;
  return agents;
}

export function getAgent(name: string): AgentDefinition | undefined {
  return agents.get(name);
}

export function listAgents(): AgentDefinition[] {
  return Array.from(agents.values());
}

export function listBackgroundAgents(): AgentDefinition[] {
  return Array.from(agents.values()).filter(a => a.startInBackground);
}

export function clearAgents(): void {
  agents.clear();
  loaded = false;
}

export async function reloadAgents(specificAgents?: string[]): Promise<{
  loaded: string[];
  skipped: string[];
  newAgents: string[];
  changed: string[];
}> {
  const previouslyLoaded = new Map(agents);
  const previouslyLoadedFiles = new Map(agentNameToFile);
  
  // Save old hashes BEFORE reloading
  const oldHashes = new Map<string, string>();
  for (const [name, file] of previouslyLoadedFiles) {
    const hash = agentSourceHashes.get(file);
    if (hash) oldHashes.set(name, hash);
  }
  
  const skipped: string[] = [];
  const toReload = specificAgents 
    ? new Set(specificAgents) 
    : null;
  
  if (toReload) {
    // Reload specific agents only - preserve others
    const preservedAgents = new Map<string, AgentDefinition>();
    const statefulSkipped: string[] = [];
    
    for (const [name, agent] of previouslyLoaded) {
      if (!toReload.has(name)) {
        // Preserve agents not being reloaded
        preservedAgents.set(name, agent);
      } else if (agent.allowsReload === false) {
        // Can't reload this one
        statefulSkipped.push(name);
        skipped.push(name);
        preservedAgents.set(name, agent);
      }
    }
    
    loadAgents(true);
    
    // Restore preserved agents (non-reloaded + skipped stateful)
    for (const [name, agent] of preservedAgents) {
      agents.set(name, agent);
    }
    
    // Reload sessions that use changed agents
    const config = getCoreConfig();
    if (config) {
      const { listActiveSessions, reloadSessionAgent } = await import('../core.js');
      const activeSessions = listActiveSessions();
      for (const s of activeSessions) {
        if (toReload.has(s.agentName) && !skipped.includes(s.agentName)) {
          await reloadSessionAgent(s.id, config);
        }
      }
    }
    
    // Find which agents actually changed source
    const changed: string[] = [];
    for (const name of toReload) {
      if (skipped.includes(name)) continue;
      const file = agentNameToFile.get(name);
      const oldFile = previouslyLoadedFiles.get(name);
      if (file && oldFile) {
        const oldHash = oldHashes.get(name);
        const newHash = computeFileHash(file);
        if (oldHash && oldHash !== newHash) {
          changed.push(name);
        }
      }
    }
    
    const loaded = Array.from(toReload).filter(name => !skipped.includes(name));
    const newAgents = Array.from(agents.keys()).filter(name => !previouslyLoaded.has(name));
    
    return { loaded, skipped, newAgents, changed };
  }
  
  // Reload all agents
  const statefulAgents = new Map<string, AgentDefinition>();
  for (const [name, agent] of previouslyLoaded) {
    if (agent.allowsReload === false) {
      statefulAgents.set(name, agent);
      skipped.push(name);
    }
  }
  
  loadAgents(true);
  
  for (const [name, agent] of statefulAgents) {
    agents.set(name, agent);
  }
  
  // Reload sessions that use changed agents
  const config = getCoreConfig();
  if (config) {
    const { listActiveSessions, reloadSessionAgent } = await import('../core.js');
    const activeSessions = listActiveSessions();
    for (const s of activeSessions) {
      if (s.agentName && !skipped.includes(s.agentName)) {
        await reloadSessionAgent(s.id, config);
      }
    }
  }
  
  // Find which agents actually changed source
  const changed: string[] = [];
  for (const [name, file] of agentNameToFile) {
    const oldFile = previouslyLoadedFiles.get(name);
    if (oldFile) {
      const oldHash = oldHashes.get(name);
      const newHash = computeFileHash(file);
      if (oldHash && oldHash !== newHash) {
        changed.push(name);
      }
    }
  }
  
  const newAgents: string[] = [];
  for (const name of agents.keys()) {
    if (!previouslyLoaded.has(name)) {
      newAgents.push(name);
    }
  }
  
  const loaded = Array.from(agents.keys()).filter(name => !skipped.includes(name));
  
  return { loaded, skipped, newAgents, changed };
}

function isAgentDefinition(obj: unknown): obj is AgentDefinition {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof (obj as AgentDefinition).name === 'string' &&
    typeof (obj as AgentDefinition).initialize === 'function'
  );
}
