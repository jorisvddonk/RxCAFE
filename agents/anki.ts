/**
 * Anki Agent
 * Study flashcards with spaced repetition using SQLite persistence.
 * Supports .apkg file import including media.
 * 
 * Commands:
 * - !help - Show available commands
 * - !sets - List all card sets
 * - !set create <name> [description] - Create a new card set
 * - !set delete <name> - Delete a card set
 * - !set info <name> - Show set details
 * - !import <setName> <front,back> - Add cards to a set (use ; or , as separator)
 * - !apkg <path> - Import an .apkg file (creates a read-only set)
 * - !apkg-dir <directory> - Import all .apkg files from directory
 * - !study [setName] - Start studying (all due cards or specific set)
 * - !show - Show the answer
 * - !again / !hard / !good / !easy - Rate card
 * - !stats [setName] - View study statistics
 * - !cards <setName> - List cards in a set
 * - !card delete <cardId> - Delete a specific card
 */

import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { createTextChunk, createNullChunk, createBinaryChunk } from '../lib/chunk.js';
import { filter, map, mergeMap, catchError, EMPTY } from '../lib/stream.js';
import { AnkiStore, type AnkiCard, type AnkiSet } from '../lib/anki-store.js';
import { parseApkg, extractCardsFromApkg, type ParsedApkg } from '../lib/apkg-parser.js';
import { Database } from 'bun:sqlite';
import { readdirSync, existsSync, statSync } from 'fs';
import { join, basename, extname } from 'path';

const ANKI_DB_PATH = process.env.ANKI_DB_PATH || './rxcafe-anki.db';
const APKG_WATCH_DIRS = (process.env.APKG_WATCH_DIRS || '').split(':').filter(Boolean);

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

**APKG Import:**
- \`!apkg <path>\` - Import an .apkg file
- \`!apkg-dir <directory>\` - Import all .apkg files from directory

**Study:**
- \`!study [setName]\` - Start studying (all due cards or specific set)
- \`!show\` - Reveal the answer
- \`!again\` / \`!hard\` \`!good\` \`!easy\` - Rate card
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

function getMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

async function importApkg(filePath: string, store: AnkiStore): Promise<{ name: string; cardCount: number; mediaCount: number; error?: string }> {
  if (!existsSync(filePath)) {
    return { name: basename(filePath), cardCount: 0, mediaCount: 0, error: 'File not found' };
  }
  
  try {
    const file = Bun.file(filePath);
    const buffer = await file.arrayBuffer();
    const uint8Buffer = new Uint8Array(buffer);
    
    const apkg = parseApkg(uint8Buffer, basename(filePath));
    const cards = extractCardsFromApkg(apkg);
    
    const setName = apkg.name;
    
    let existingSet = await store.getSetByName(setName);
    if (existingSet) {
      await store.deleteSet(existingSet.id);
    }
    
    const setId = await store.createSet(setName, `Imported from ${basename(filePath)}`, true, filePath);
    
    const cardsToAdd = cards.map(c => ({ front: c.front, back: c.back }));
    await store.addCards(setId, cardsToAdd);
    
    let mediaCount = 0;
    for (const [filename, data] of apkg.media) {
      const mimeType = getMimeType(filename);
      await store.addMedia(setId, filename, mimeType, data);
      mediaCount++;
    }
    
    return { name: setName, cardCount: cards.length, mediaCount };
  } catch (err: any) {
    return { name: basename(filePath), cardCount: 0, mediaCount: 0, error: err.message };
  }
}

async function emitCardChunks(
  card: AnkiCard,
  store: AnkiStore,
  session: AgentSessionContext,
  header: string,
  showAnswer: boolean = false
): Promise<void> {
  const stripImages = (html: string) => html.replace(/<img[^>]*>/gi, '').trim();
  
  let content = header;
  if (showAnswer) {
    content += `\n\n${stripImages(card.back)}\n\nRate: \`!again\` \`!hard\` \`!good\` \`!easy\``;
  } else {
    content += `\n\n${stripImages(card.front)}`;
  }
  
  const textChunk = createMarkdownChunk(content, 'anki-agent', {
    'chat.role': 'assistant',
    'anki.card-id': card.id
  });
  
  session.outputStream.next(textChunk);
  
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  const neededMedia = new Set<string>();
  let match;
  const text = showAnswer ? card.back : card.front;
  while ((match = imgRegex.exec(text)) !== null) {
    neededMedia.add(match[1]);
  }
  
  for (const filename of neededMedia) {
    const mediaData = await store.getMedia(card.setId, filename);
    if (mediaData) {
      const mediaChunk = createBinaryChunk(mediaData.data, mediaData.mimeType, 'anki-agent', {
        'chat.role': 'assistant',
        'anki.media-filename': filename
      });
      session.outputStream.next(mediaChunk);
    }
  }
}

export const ankiAgent: AgentDefinition = {
  name: 'anki',
  description: 'Study flashcards with spaced repetition',
  allowsReload: false,  // Agent maintains flashcard state - reload would lose progress
  configSchema: {
    type: 'object',
    properties: {},
    required: []
  },
  
  async initialize(session: AgentSessionContext) {
    const store = getAnkiStore();
    let studySession = createStudySession();
    
    session.outputStream.next(createMarkdownChunk(HELP_MESSAGE, 'anki-agent', { 'chat.role': 'assistant' }));
    
    if (APKG_WATCH_DIRS.length > 0) {
      for (const dir of APKG_WATCH_DIRS) {
        if (existsSync(dir)) {
          const files = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.apkg'));
          for (const file of files) {
            const filePath = join(dir, file);
            const result = await importApkg(filePath, store);
            if (result.cardCount > 0) {
              session.outputStream.next(createMarkdownChunk(
                `📦 Auto-imported: **${result.name}** (${result.cardCount} cards, ${result.mediaCount} media)`,
                'anki-agent',
                { 'chat.role': 'assistant' }
              ));
            }
          }
        }
      }
    }
    
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
        try {
          const text = (chunk.content as string).trim();
          
          if (text === '!help') {
            return createMarkdownChunk(HELP_MESSAGE, 'anki-agent', { 'chat.role': 'assistant' });
          }
          
          if (text === '!sets') {
            const sets = await store.listSets();
            if (sets.length === 0) {
              return createMarkdownChunk('No card sets yet. Use `!set create <name>` or `!apkg <path>` to create one.', 'anki-agent', { 'chat.role': 'assistant' });
            }
            const lines = sets.map(s => {
              const icon = s.isApkg ? '📦' : '📁';
              return `${icon} **${s.name}** (${s.cardCount} cards, ${s.dueCount} due)${s.description ? ` - ${s.description}` : ''}`;
            });
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
            const media = await store.getMediaBySet(set.id);
            const lines = [
              `${set.isApkg ? '📦' : '📁'} **${set.name}**`,
              set.description || '_No description_',
              ``,
              `Cards: ${set.cardCount}`,
              `Due: ${set.dueCount}`,
              `Media: ${media.length}`,
              set.isApkg ? `Source: ${set.apkgPath}` : '',
              ``,
              `Cards:`,
              ...cards.slice(0, 10).map(c => `  - [${c.id}] ${c.front.substring(0, 50)}${c.front.length > 50 ? '...' : ''}`),
              cards.length > 10 ? `  ... and ${cards.length - 10} more` : ''
            ];
            return createMarkdownChunk(lines.filter(Boolean).join('\n'), 'anki-agent', { 'chat.role': 'assistant' });
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
          
          if (text.startsWith('!apkg ')) {
            const filePath = text.slice(6).trim();
            const result = await importApkg(filePath, store);
            
            if (result.error) {
              return createMarkdownChunk(`❌ Failed to import ${result.name}: ${result.error}`, 'anki-agent', { 'chat.role': 'assistant' });
            }
            
            return createMarkdownChunk(`✅ Imported **${result.name}** (${result.cardCount} cards, ${result.mediaCount} media)`, 'anki-agent', { 'chat.role': 'assistant' });
          }
          
          if (text.startsWith('!apkg-dir ')) {
            const dirPath = text.slice(10).trim();
            
            if (!existsSync(dirPath)) {
              return createMarkdownChunk(`❌ Directory not found: ${dirPath}`, 'anki-agent', { 'chat.role': 'assistant' });
            }
            
            const stat = statSync(dirPath);
            if (!stat.isDirectory()) {
              return createMarkdownChunk(`❌ Not a directory: ${dirPath}`, 'anki-agent', { 'chat.role': 'assistant' });
            }
            
            const files = readdirSync(dirPath).filter(f => f.toLowerCase().endsWith('.apkg'));
            
            if (files.length === 0) {
              return createMarkdownChunk(`No .apkg files found in ${dirPath}`, 'anki-agent', { 'chat.role': 'assistant' });
            }
            
            const results: string[] = [];
            let totalCards = 0;
            
            for (const file of files) {
              const filePath = join(dirPath, file);
              const result = await importApkg(filePath, store);
              
              if (result.error) {
                results.push(`❌ ${file}: ${result.error}`);
              } else {
                results.push(`✅ ${result.name}: ${result.cardCount} cards, ${result.mediaCount} media`);
                totalCards += result.cardCount;
              }
            }
            
            return createMarkdownChunk(`**Imported ${files.length} decks (${totalCards} cards):**\n\n${results.join('\n')}`, 'anki-agent', { 'chat.role': 'assistant' });
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
            
            await emitCardChunks(studySession.currentCard, store, session, `📚 Card 1`);
            
            const callbacks = session.callbacks;
            if (callbacks?.onFinish) callbacks.onFinish();
            return null;
          }
          
          if (text === '!show') {
            if (!studySession.currentCard) {
              return createMarkdownChunk('No card selected. Use `!study` first.', 'anki-agent', { 'chat.role': 'assistant' });
            }
            
            studySession.showingFront = false;
            
            await emitCardChunks(studySession.currentCard, store, session, `📚 Card`, true);
            
            const callbacks = session.callbacks;
            if (callbacks?.onFinish) callbacks.onFinish();
            return null;
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
              
              await emitCardChunks(studySession.currentCard, store, session, `📚 Card ${studySession.reviewed + 1}`);
              
              const callbacks = session.callbacks;
              if (callbacks?.onFinish) callbacks.onFinish();
              return null;
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
        } catch (err: any) {
          console.error('[anki-agent] Error processing chunk:', err);
          return createMarkdownChunk(
            `❌ Error: ${err.message}`,
            'anki-agent',
            { 'chat.role': 'assistant' }
          );
        }
      }),
      catchError((error: Error) => {
        console.error('[anki-agent] Error in pipeline:', error);
        session.errorStream.next(error);
        session.outputStream.next(createMarkdownChunk(
          `❌ Error: ${error.message}`,
          'anki-agent',
          { 'chat.role': 'assistant' }
        ));
        return EMPTY;
      })
    ).subscribe({
      next: (chunk: Chunk | null) => {
        if (chunk) {
          session.outputStream.next(chunk);
          const callbacks = session.callbacks;
          if (callbacks?.onFinish) {
            callbacks.onFinish();
          }
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
