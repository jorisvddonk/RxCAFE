/**
 * RXCAFE Agent Loader
 * Auto-discovers and loads agent definitions from agents/*.ts
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, existsSync } from 'fs';
import type { AgentDefinition } from './agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const agents = new Map<string, AgentDefinition>();
let loaded = false;

export async function loadAgents(): Promise<Map<string, AgentDefinition>> {
  if (loaded) {
    return agents;
  }
  
  const agentsDir = join(__dirname, '..', 'agents');
  
  try {
    if (!existsSync(agentsDir)) {
      console.log(`[AgentLoader] Agents directory not found: ${agentsDir}`);
      loaded = true;
      return agents;
    }
    
    const files = readdirSync(agentsDir)
      .filter(f => f.endsWith('.ts'))
      .map(f => join(agentsDir, f));
    
    for (const file of files) {
      try {
        const module = await import(file);
        
        // Check named exports first
        for (const exportName of Object.keys(module)) {
          if (exportName === 'default') continue;
          
          const exported = module[exportName];
          
          if (isAgentDefinition(exported) && !agents.has(exported.name)) {
            agents.set(exported.name, exported);
            console.log(`[AgentLoader] Loaded agent: ${exported.name}${exported.startInBackground ? ' (background)' : ''}`);
          }
        }
        
        // Then check default export if no named agent was found
        if (module.default && isAgentDefinition(module.default) && !agents.has(module.default.name)) {
          agents.set(module.default.name, module.default);
          console.log(`[AgentLoader] Loaded agent: ${module.default.name}${module.default.startInBackground ? ' (background)' : ''}`);
        }
      } catch (err) {
        console.error(`[AgentLoader] Failed to load ${file}:`, err);
      }
    }
  } catch (err) {
    console.error('[AgentLoader] Failed to scan agents directory:', err);
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

function isAgentDefinition(obj: unknown): obj is AgentDefinition {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof (obj as AgentDefinition).name === 'string' &&
    typeof (obj as AgentDefinition).initialize === 'function'
  );
}
