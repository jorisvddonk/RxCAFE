/**
 * Anki Agent
 * Study flashcards with spaced repetition using SQLite persistence.
 * 
 * Commands:
 * - !help - Show available commands
 * - !sets - List all card sets
 * - !set create <name> [description] - Create a new card set
 * - !set delete <name> - Delete a card set
 * - !set info <name> - Show set details
 * - !import <setName> <front,back or front;back> - Add cards to a set
 * - !study [setName] - Start studying (optionally filter by set)
 * - !show - Show the answer
 * - !again - Rate card as "Again"
 * - !hard - Rate card as "Hard"
 * - !good - Rate card as "Good"
 * - !easy - Rate card as "Easy"
 * - !stats [setName] - Show study statistics
 * - !cards <setName> - List cards in a set
 * - !card delete <cardId> - Delete a specific card
 */

import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { createTextChunk, createNullChunk } from '../lib/chunk.js';
import { filter, map, mergeMap, catchError, EMPTY } from '../lib/stream.js';
import { AnkiStore, type AnkiCard, type AnkiSet } from '../lib/anki-store.js';
import { Database } from 'bun:sqlite';

const ANKI_DB_PATH = process.env.ANKI_DB_PATH || './rxcafe-anki.db';

function createMarkdownChunk(content: string, source: string, annotations: Record<string, any> = {}): Chunk {
  return createTextChunk(content, source, { ...annotations, 'parsers.markdown.enabled': true });
}

const HELP_MESSAGE = `📚 **Anki Flashcard Agent**

**Card Sets:**
- \`!sets\` - List all card sets
- \`!set create <name> [description]\` - Create a new set
- \`!set delete <name>\` - Delete a set
- \`!set info <name>\` - Show set details

**Cards:**
- \`!import <setName> <front,back>\` - Add cards (use ; or , as separator)
- \`!cards <setName>\` - List cards in a set
- \`!card delete <cardId>\` - Delete a card

**Study:**
- \`!study [setName]\` - Start studying (all due cards or specific set)
- \`!show\` - Reveal the answer
- \`!again\` / \`!hard\` / \`!good\` / \`!easy\` - Rate card
- \`!stats [setName]\` - View statistics`;

let ankiStore: AnkiStore | null = null;

function getAnkiStore(): AnkiStore {
  if (!ankiStore) {
    const db = new Database(ANKI_DB_PATH);
    ankiStore = new AnkiStore(db);
  }
  return ankiStore;
}

interface StudySession {
  currentCard: AnkiCard | null;
  showingFront: boolean;
  reviewed: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
  filterSetId: number | null;
}

function createStudySession(): StudySession {
  return {
    currentCard: null,
    showingFront: true,
    reviewed: 0,
    again: 0,
    hard: 0,
    good: 0,
    easy: 0,
    filterSetId: null
  };
}

function scheduleCard(card: AnkiCard, rating: 'again' | 'hard' | 'good' | 'easy'): { ease: number; interval: number; due: number } {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  
  let newEase = card.ease;
  let newInterval = card.interval;
  
  switch (rating) {
    case 'again':
      newInterval = 1;
      newEase = Math.max(1.3, card.ease - 0.2);
      break;
    case 'hard':
      newInterval = Math.max(1, Math.round(card.interval * 1.2));
      newEase = Math.max(1.3, card.ease - 0.15);
      break;
    case 'good':
      if (card.interval === 0) {
        newInterval = 1;
      } else if (card.interval === 1) {
        newInterval = 6;
      } else {
        newInterval = Math.round(card.interval * card.ease);
      }
      break;
    case 'easy':
      if (card.interval === 0) {
        newInterval = 4;
      } else {
        newInterval = Math.round(card.interval * card.ease * 1.3);
      }
      newEase = card.ease + 0.15;
      break;
  }
  
  return {
    ease: newEase,
    interval: newInterval,
    due: now + newInterval * DAY_MS
  };
}

export const ankiAgent: AgentDefinition = {
  name: 'anki',
  description: 'Study flashcards with spaced repetition',
  configSchema: {
    type: 'object',
    properties: {},
    required: []
  },
  
  async initialize(session: AgentSessionContext) {
    const store = getAnkiStore();
    let studySession = createStudySession();
    
    session.outputStream.next(createMarkdownChunk(HELP_MESSAGE, 'anki-agent', { 'chat.role': 'assistant' }));
    
    session.inputStream.pipe(
      filter((chunk: Chunk) => chunk.contentType === 'text'),
      map((chunk: Chunk) => {
        if (chunk.annotations['chat.role']) return chunk;
        return { ...chunk, annotations: { ...chunk.annotations, 'chat.role': 'user' } };
      }),
      filter((chunk: Chunk) => {
        const trustLevel = chunk.annotations['security.trust-level'];
        return !trustLevel || trustLevel.trusted !== false;
      }),
      mergeMap(async (chunk: Chunk) => {
        const text = (chunk.content as string).trim();
        
        if (text === '!help') {
          return createMarkdownChunk(HELP_MESSAGE, 'anki-agent', { 'chat.role': 'assistant' });
        }
        
        if (text === '!sets') {
          const sets = await store.listSets();
          if (sets.length === 0) {
            return createMarkdownChunk('No card sets yet. Use `!set create <name>` to create one.', 'anki-agent', { 'chat.role': 'assistant' });
          }
          const lines = sets.map(s => `📁 **${s.name}** (${s.cardCount} cards, ${s.dueCount} due)${s.description ? ` - ${s.description}` : ''}`);
          return createMarkdownChunk(`**Card Sets:**\n\n${lines.join('\n')}`, 'anki-agent', { 'chat.role': 'assistant' });
        }
        
        if (text.startsWith('!set create ')) {
          const args = text.slice(12).trim();
          const spaceIdx = args.indexOf(' ');
          const name = spaceIdx > 0 ? args.slice(0, spaceIdx) : args;
          const description = spaceIdx > 0 ? args.slice(spaceIdx + 1) : undefined;
          
          try {
            const id = await store.createSet(name, description);
            return createMarkdownChunk(`✅ Created set "**${name}**" (ID: ${id})`, 'anki-agent', { 'chat.role': 'assistant' });
          } catch (err: any) {
            return createMarkdownChunk(`❌ Error: ${err.message}`, 'anki-agent', { 'chat.role': 'assistant' });
          }
        }
        
        if (text.startsWith('!set delete ')) {
          const name = text.slice(12).trim();
          const set = await store.getSetByName(name);
          if (!set) {
            return createMarkdownChunk(`❌ Set "${name}" not found.`, 'anki-agent', { 'chat.role': 'assistant' });
          }
          await store.deleteSet(set.id);
          return createMarkdownChunk(`✅ Deleted set "**${name}**" and all its cards.`, 'anki-agent', { 'chat.role': 'assistant' });
        }
        
        if (text.startsWith('!set info ')) {
          const name = text.slice(10).trim();
          const set = await store.getSetByName(name);
          if (!set) {
            return createMarkdownChunk(`❌ Set "${name}" not found.`, 'anki-agent', { 'chat.role': 'assistant' });
          }
          const cards = await store.getCardsBySet(set.id);
          const lines = [
            `📁 **${set.name}**`,
            set.description || '_No description_',
            ``,
            `Cards: ${set.cardCount}`,
            `Due: ${set.dueCount}`,
            ``,
            `Cards:`,
            ...cards.slice(0, 10).map(c => `  - [${c.id}] ${c.front.substring(0, 50)}${c.front.length > 50 ? '...' : ''}`),
            cards.length > 10 ? `  ... and ${cards.length - 10} more` : ''
          ];
          return createMarkdownChunk(lines.join('\n'), 'anki-agent', { 'chat.role': 'assistant' });
        }
        
        if (text.startsWith('!import ')) {
          const rest = text.slice(8).trim();
          const spaceIdx = rest.indexOf(' ');
          if (spaceIdx < 0) {
            return createMarkdownChunk('Usage: `!import <setName> <front,back>`', 'anki-agent', { 'chat.role': 'assistant' });
          }
          const setName = rest.slice(0, spaceIdx);
          const csv = rest.slice(spaceIdx + 1);
          
          const set = await store.getSetByName(setName);
          if (!set) {
            return createMarkdownChunk(`❌ Set "${setName}" not found. Use \`!set create ${setName}\` first.`, 'anki-agent', { 'chat.role': 'assistant' });
          }
          
          const cards: Array<{ front: string; back: string }> = [];
          const lines = csv.split('\n').filter(l => l.trim());
          
          for (const line of lines) {
            const parts = line.includes(';') ? line.split(';') : line.split(',');
            if (parts.length >= 2) {
              cards.push({
                front: parts[0].trim(),
                back: parts[1].trim()
              });
            }
          }
          
          if (cards.length === 0) {
            return createMarkdownChunk('❌ No valid cards found. Format: `front,back` or `front;back`', 'anki-agent', { 'chat.role': 'assistant' });
          }
          
          const count = await store.addCards(set.id, cards);
          return createMarkdownChunk(`✅ Imported ${count} cards into "**${setName}**". Total: ${set.cardCount + count}`, 'anki-agent', { 'chat.role': 'assistant' });
        }
        
        if (text.startsWith('!cards ')) {
          const setName = text.slice(7).trim();
          const set = await store.getSetByName(setName);
          if (!set) {
            return createMarkdownChunk(`❌ Set "${setName}" not found.`, 'anki-agent', { 'chat.role': 'assistant' });
          }
          const cards = await store.getCardsBySet(set.id);
          if (cards.length === 0) {
            return createMarkdownChunk(`No cards in set "**${setName}**".`, 'anki-agent', { 'chat.role': 'assistant' });
          }
          const lines = cards.map(c => {
            const dueText = c.due <= Date.now() ? ' (due)' : '';
            return `[${c.id}] ${c.front.substring(0, 40)}${c.front.length > 40 ? '...' : ''}${dueText}`;
          });
          return createMarkdownChunk(`**Cards in ${setName}:**\n${lines.join('\n')}`, 'anki-agent', { 'chat.role': 'assistant' });
        }
        
        if (text.startsWith('!card delete ')) {
          const cardId = parseInt(text.slice(13).trim(), 10);
          if (isNaN(cardId)) {
            return createMarkdownChunk('Usage: `!card delete <cardId>`', 'anki-agent', { 'chat.role': 'assistant' });
          }
          const deleted = await store.deleteCard(cardId);
          if (deleted) {
            return createMarkdownChunk(`✅ Deleted card ${cardId}.`, 'anki-agent', { 'chat.role': 'assistant' });
          }
          return createMarkdownChunk(`❌ Card ${cardId} not found.`, 'anki-agent', { 'chat.role': 'assistant' });
        }
        
        if (text.startsWith('!stats')) {
          const setName = text.length > 6 ? text.slice(7).trim() : null;
          let setId: number | undefined;
          
          if (setName) {
            const set = await store.getSetByName(setName);
            if (!set) {
              return createMarkdownChunk(`❌ Set "${setName}" not found.`, 'anki-agent', { 'chat.role': 'assistant' });
            }
            setId = set.id;
          }
          
          const totalCards = await store.getCardCount(setId);
          const dueCards = await store.getDueCount(setId);
          
          return createMarkdownChunk(`📊 **Statistics**${setName ? ` (${setName})` : ''}

Total cards: ${totalCards}
Due now: ${dueCards}

Current session:
- Reviewed: ${studySession.reviewed}
- Again: ${studySession.again}
- Hard: ${studySession.hard}
- Good: ${studySession.good}
- Easy: ${studySession.easy}`, 'anki-agent', { 'chat.role': 'assistant' });
        }
        
        if (text.startsWith('!study')) {
          const setName = text.length > 6 ? text.slice(7).trim() : null;
          let setId: number | undefined;
          
          if (setName) {
            const set = await store.getSetByName(setName);
            if (!set) {
              return createMarkdownChunk(`❌ Set "${setName}" not found.`, 'anki-agent', { 'chat.role': 'assistant' });
            }
            setId = set.id;
            studySession.filterSetId = set.id;
          } else {
            studySession.filterSetId = null;
          }
          
          studySession = createStudySession();
          studySession.filterSetId = setId || null;
          
          const dueCards = await store.getDueCards(setId, 1);
          if (dueCards.length === 0) {
            return createMarkdownChunk(`🎉 No cards due${setName ? ` in "${setName}"` : ''}! Great job!`, 'anki-agent', { 'chat.role': 'assistant' });
          }
          
          studySession.currentCard = dueCards[0];
          studySession.showingFront = true;
          
          return createMarkdownChunk(
            `📚 Card 1\n\n${studySession.currentCard.front}\n\nType \`!show\` to reveal answer, or rate: \`!again\` \`!hard\` \`!good\` \`!easy\``,
            'anki-agent',
            { 'chat.role': 'assistant', 'anki.card-id': studySession.currentCard.id }
          );
        }
        
        if (text === '!show') {
          if (!studySession.currentCard) {
            return createMarkdownChunk('No card selected. Use `!study` first.', 'anki-agent', { 'chat.role': 'assistant' });
          }
          
          studySession.showingFront = false;
          
          return createMarkdownChunk(
            `${studySession.currentCard.front}\n\n---\n\n${studySession.currentCard.back}\n\nRate: \`!again\` \`!hard\` \`!good\` \`!easy\``,
            'anki-agent',
            { 'chat.role': 'assistant', 'anki.card-id': studySession.currentCard.id }
          );
        }
        
        const ratings: Array<'again' | 'hard' | 'good' | 'easy'> = ['again', 'hard', 'good', 'easy'];
        for (const rating of ratings) {
          if (text === `!${rating}`) {
            if (!studySession.currentCard) {
              return createMarkdownChunk('No card to rate. Use `!study` first.', 'anki-agent', { 'chat.role': 'assistant' });
            }
            
            const updates = scheduleCard(studySession.currentCard, rating);
            await store.updateCard(studySession.currentCard.id, {
              ease: updates.ease,
              interval: updates.interval,
              due: updates.due,
              reviews: studySession.currentCard.reviews + 1
            });
            
            studySession.reviewed++;
            switch (rating) {
              case 'again': studySession.again++; break;
              case 'hard': studySession.hard++; break;
              case 'good': studySession.good++; break;
              case 'easy': studySession.easy++; break;
            }
            
            const intervalText = updates.interval === 1 ? '1 day' : `${updates.interval} days`;
            const nextCards = await store.getDueCards(studySession.filterSetId || undefined, 1);
            
            if (nextCards.length === 0) {
              const response = createMarkdownChunk(
                `Rated: ${rating.toUpperCase()}\nNext review: ${intervalText}\n\n🎉 All done for now!`,
                'anki-agent',
                { 'chat.role': 'assistant' }
              );
              studySession.currentCard = null;
              return response;
            }
            
            studySession.currentCard = nextCards[0];
            studySession.showingFront = true;
            
            session.outputStream.next(createMarkdownChunk(
              `Rated: ${rating.toUpperCase()}\nNext review: ${intervalText}`,
              'anki-agent',
              { 'chat.role': 'assistant' }
            ));
            
            return createMarkdownChunk(
              `📚 Card ${studySession.reviewed + 1}\n\n${studySession.currentCard.front}\n\nType \`!show\` to reveal answer, or rate: \`!again\` \`!hard\` \`!good\` \`!easy\``,
              'anki-agent',
              { 'chat.role': 'assistant', 'anki.card-id': studySession.currentCard.id }
            );
          }
        }
        
        if (text.startsWith('!')) {
          return createMarkdownChunk(
            `Unknown command. Type \`!help\` for available commands.`,
            'anki-agent',
            { 'chat.role': 'assistant' }
          );
        }
        
        return createMarkdownChunk(
          `Type \`!help\` for available commands.`,
          'anki-agent',
          { 'chat.role': 'assistant' }
        );
      }),
      catchError((error: Error) => {
        session.errorStream.next(error);
        return EMPTY;
      })
    ).subscribe({
      next: (chunk: Chunk) => {
        session.outputStream.next(chunk);
        const callbacks = session.callbacks;
        if (callbacks?.onFinish) {
          callbacks.onFinish();
        }
      },
      error: (error: Error) => session.errorStream.next(error)
    });
    
    session.pipelineSubscription?.unsubscribe();
  },
  
  async persistState() {
  }
};

export default ankiAgent;
