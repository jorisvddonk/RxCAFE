/**
 * Dice Agent
 * Handles dice rolling with full notation support (2d6, 1d20+5, 4d6kh3, etc.)
 * Supports both chat and game-dice UI modes.
 */

import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { createTextChunk, createNullChunk, annotateChunk } from '../lib/chunk.js';
import { EMPTY, filter, map, mergeMap, catchError } from '../lib/stream.js';

interface DiceRoll {
  notation: string;
  dice: number[];
  modifier: number;
  total: number;
  timestamp: number;
}

interface DiceState {
  rolls: DiceRoll[];
  llmComments: boolean;
}

function parseDiceNotation(notation: string): { dice: number[]; modifier: number; error?: string } {
  const dice: number[] = [];
  let modifier = 0;
  
  const cleaned = notation.toLowerCase().replace(/\s+/g, '');
  
  // Handle modifiers at the end: +5, -2, +5-3 (last one wins)
  const modifierMatch = cleaned.match(/([+-]\d+)$/);
  if (modifierMatch) {
    modifier = parseInt(modifierMatch[1], 10);
  }
  
  // Remove the modifier from the string for dice parsing
  const dicePart = cleaned.replace(/([+-]\d+)$/, '');
  
  // Split by + or - but keep the separator for parsing
  // Handle multiple dice groups like "2d6+d12" or "d6+d12-1d4"
  const groups: { dice: number[], modifier: number }[] = [];
  
  // First, extract any inline modifiers from the dice part (like "2d6-1")
  let remaining = dicePart;
  while (remaining.length > 0) {
    let matched = false;
    
    // Try to match XdYkhZ (keep highest)
    const khMatch = remaining.match(/^(\d+)d(\d+)kh(\d+)/);
    if (khMatch) {
      const count = parseInt(khMatch[1], 10);
      const sides = parseInt(khMatch[2], 10);
      const keep = parseInt(khMatch[3], 10);
      const groupDice: number[] = [];
      for (let i = 0; i < count; i++) {
        groupDice.push(Math.floor(Math.random() * sides) + 1);
      }
      groupDice.sort((a, b) => b - a);
      while (groupDice.length > keep) groupDice.pop();
      groups.push({ dice: groupDice, modifier: 0 });
      remaining = remaining.slice(khMatch[0].length);
      matched = true;
      continue;
    }
    
    // Try to match XdYklZ (keep lowest)
    const klMatch = remaining.match(/^(\d+)d(\d+)kl(\d+)/);
    if (klMatch) {
      const count = parseInt(klMatch[1], 10);
      const sides = parseInt(klMatch[2], 10);
      const keep = parseInt(klMatch[3], 10);
      const groupDice: number[] = [];
      for (let i = 0; i < count; i++) {
        groupDice.push(Math.floor(Math.random() * sides) + 1);
      }
      groupDice.sort((a, b) => a - b);
      while (groupDice.length > keep) groupDice.pop();
      groups.push({ dice: groupDice, modifier: 0 });
      remaining = remaining.slice(klMatch[0].length);
      matched = true;
      continue;
    }
    
    // Try to match XdY
    const standardMatch = remaining.match(/^(\d+)d(\d+)/);
    if (standardMatch) {
      const count = parseInt(standardMatch[1], 10);
      const sides = parseInt(standardMatch[2], 10);
      if (count > 100) return { dice: [], modifier: 0, error: 'Too many dice (max 100)' };
      if (sides > 1000) return { dice: [], modifier: 0, error: 'Too many sides (max 1000)' };
      const groupDice: number[] = [];
      for (let i = 0; i < count; i++) {
        groupDice.push(Math.floor(Math.random() * sides) + 1);
      }
      groups.push({ dice: groupDice, modifier: 0 });
      remaining = remaining.slice(standardMatch[0].length);
      matched = true;
      continue;
    }
    
    // Try to match dX (single die)
    const singleMatch = remaining.match(/^d(\d+)/);
    if (singleMatch) {
      const sides = parseInt(singleMatch[1], 10);
      if (sides > 1000) return { dice: [], modifier: 0, error: 'Too many sides (max 1000)' };
      groups.push({ dice: [Math.floor(Math.random() * sides) + 1], modifier: 0 });
      remaining = remaining.slice(singleMatch[0].length);
      matched = true;
      continue;
    }
    
    // Skip + or - between dice groups
    if (remaining[0] === '+' || remaining[0] === '-') {
      remaining = remaining.slice(1);
      matched = true;
      continue;
    }
    
    if (!matched) {
      if (remaining.length > 0) {
        return { dice: [], modifier: 0, error: `Invalid dice notation: ${notation}` };
      }
      break;
    }
  }
  
  // Combine all groups
  for (const group of groups) {
    dice.push(...group.dice);
    modifier += group.modifier;
  }
  
  if (dice.length === 0 && dicePart.length > 0) {
    return { dice: [], modifier: 0, error: `Invalid dice notation: ${notation}` };
  }
  
  return { dice, modifier };
}

function formatDiceResult(roll: DiceRoll): string {
  const diceStr = roll.dice.join(' + ');
  const modStr = roll.modifier !== 0 ? (roll.modifier > 0 ? ` + ${roll.modifier}` : ` - ${Math.abs(roll.modifier)}`) : '';
  return `${diceStr}${modStr} = ${roll.total}`;
}

async function generateLLMComment(session: AgentSessionContext, roll: DiceRoll, lastRolls: DiceRoll[]): Promise<string> {
  try {
    const evaluator = session.createLLMChunkEvaluator();
    const historyContext = lastRolls.slice(-5).map(r => `${r.notation}: ${r.total}`).join(', ');
    
    const prompt = `The user just rolled ${roll.notation} and got ${roll.total}. ${historyContext ? `Previous rolls: ${historyContext}.` : ''} Give a brief, fun comment (1 sentence) about this roll. Be playful.`;
    
    const inputChunk = createTextChunk(prompt, 'com.rxcafe.dice-comment', { 'chat.role': 'user' });
    
    let comment = '';
    for await (const chunk of evaluator.evaluateChunk(inputChunk)) {
      if (chunk.contentType === 'text' && chunk.content) {
        comment += chunk.content;
      }
    }
    
    return comment.trim();
  } catch (e) {
    return '';
  }
}

export const diceAgent: AgentDefinition = {
  name: 'dice',
  description: 'Roll dice with full notation support (2d6, 1d20+5, 4d6kh3)',
  configSchema: {
    type: 'object',
    properties: {},
    required: []
  },
  supportedUIs: ['chat', 'game-dice'],
  
  initialize(session: AgentSessionContext) {
    let state: DiceState = {
      rolls: [],
      llmComments: true,
    };
    
    const loadState = async () => {
      for (const chunk of session.history) {
        if (chunk.contentType === 'null') {
          if (chunk.annotations['dice.roll']) {
            const roll = chunk.annotations['dice.roll'] as DiceRoll;
            state.rolls.push(roll);
          }
          if (chunk.annotations['dice.llmComments'] !== undefined) {
            state.llmComments = chunk.annotations['dice.llmComments'] === true;
          }
        }
      }
    };
    
    loadState();
    
    const sub = session.inputStream.pipe(
      filter((chunk: Chunk) => chunk.contentType === 'text'),
      
      map((chunk: Chunk) => {
        if (chunk.annotations['chat.role']) return chunk;
        return annotateChunk(chunk, 'chat.role', 'user');
      }),
      
      mergeMap(async (chunk: Chunk) => {
        const content = chunk.content?.toString() || '';
        const trimmed = content.trim();
        
        if (trimmed.startsWith('!roll ') || trimmed === '!roll') {
          const notation = trimmed.replace('!roll ', '').trim() || '1d20';
          const parsed = parseDiceNotation(notation);
          
          if (parsed.error) {
            const errorChunk = createTextChunk(
              `Error: ${parsed.error}`,
              'dice-agent',
              { 'chat.role': 'assistant', 'dice.error': true }
            );
            return [errorChunk];
          }
          
          const total = parsed.dice.reduce((a, b) => a + b, 0) + parsed.modifier;
          
          const roll: DiceRoll = {
            notation,
            dice: parsed.dice,
            modifier: parsed.modifier,
            total,
            timestamp: Date.now(),
          };
          
          state.rolls.push(roll);
          
          let comment = '';
          if (state.llmComments && session.config.ollamaModel) {
            comment = await generateLLMComment(session, roll, state.rolls);
          }
          
          const resultText = `🎲 Rolled ${notation}: ${formatDiceResult(roll)}${roll.dice.length > 1 ? ` (${roll.dice.length} dice)` : ''}${comment ? `\n\n${comment}` : ''}`;
          
          const resultChunk = createTextChunk(
            resultText,
            'dice-agent',
            {
              'chat.role': 'assistant',
              'dice.notation': notation,
              'dice.rolls': roll.dice,
              'dice.modifier': roll.modifier,
              'dice.total': roll.total,
              'dice.timestamp': roll.timestamp,
              'dice.comment': comment || undefined,
            }
          );
          
          const stateChunk = createNullChunk(
            'dice-agent',
            { 'dice.roll': roll }
          );
          
          return [resultChunk, stateChunk];
        }
        
        if (trimmed === '!history' || trimmed === '!h') {
          if (state.rolls.length === 0) {
            return [createTextChunk(
              'No rolls yet. Use !roll XdY to roll dice.',
              'dice-agent',
              { 'chat.role': 'assistant', 'dice.history': true }
            )];
          }
          
          const historyText = '📜 Roll History:\n' + 
            state.rolls.slice(-10).reverse().map((r, i) => 
              `${state.rolls.length - i}. 🎲 ${r.notation} = ${r.total}`
            ).join('\n');
          
          return [createTextChunk(
            historyText,
            'dice-agent',
            { 'chat.role': 'assistant', 'dice.history': true }
          )];
        }
        
        if (trimmed === '!clear' || trimmed === '!c') {
          state.rolls = [];
          
          return [createTextChunk(
            'Roll history cleared!',
            'dice-agent',
            { 'chat.role': 'assistant', 'dice.clear': true }
          ), createNullChunk('dice-agent', { 'dice.clear': true })];
        }
        
        if (trimmed === '!comment on' || trimmed === '!llm on') {
          state.llmComments = true;
          
          return [createTextChunk(
            'LLM comments enabled! 🤖',
            'dice-agent',
            { 'chat.role': 'assistant', 'dice.llmComments': true }
          ), createNullChunk('dice-agent', { 'dice.llmComments': true })];
        }
        
        if (trimmed === '!comment off' || trimmed === '!llm off') {
          state.llmComments = false;
          
          return [createTextChunk(
            'LLM comments disabled.',
            'dice-agent',
            { 'chat.role': 'assistant', 'dice.llmComments': false }
          ), createNullChunk('dice-agent', { 'dice.llmComments': false })];
        }
        
        if (trimmed.startsWith('!')) {
          return [createTextChunk(
            `Unknown command: ${trimmed}\n\nAvailable commands:\n!roll XdY - Roll dice (e.g., !roll 2d6+5)\n!history - Show roll history\n!clear - Clear history\n!comment on/off - Toggle LLM comments`,
            'dice-agent',
            { 'chat.role': 'assistant' }
          )];
        }
        
        return [chunk];
      }),
      
      catchError((error: Error) => {
        session.errorStream.next(error);
        return EMPTY;
      })
    ).subscribe({
      next: (chunks: Chunk | Chunk[]) => {
        if (Array.isArray(chunks)) {
          for (const chunk of chunks) {
            session.outputStream.next(chunk);
          }
        } else {
          session.outputStream.next(chunks);
        }
      },
      error: (error: Error) => session.errorStream.next(error)
    });
    
    session.pipelineSubscription = sub;
  }
};

export default diceAgent;
