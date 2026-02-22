/**
 * APKG Parser
 * Parse Anki .apkg files (SQLite database wrapped in ZIP)
 */

import { unzipSync } from 'fflate';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

export interface ApkgNote {
  id: number;
  guid: string;
  mid: number;
  mod: number;
  usn: number;
  tags: string;
  flds: string;
  sfld: string;
  csum: number;
  flags: number;
  data: string;
}

export interface ApkgCard {
  id: number;
  nid: number;
  did: number;
  ord: number;
  mod: number;
  usn: number;
  type: number;
  queue: number;
  due: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
  left: number;
  odue: number;
  odid: number;
  flags: number;
  data: string;
}

export interface ApkgModel {
  id: number;
  name: string;
  type: number;
  mod: number;
  usn: number;
  sortf: number;
  did: number;
  tmpls: ApkgTemplate[];
  flds: ApkgField[];
  css: string;
  latexPre: string;
  latexPost: string;
  latexsvg: number;
  req: any[];
  vers: number[];
}

export interface ApkgTemplate {
  name: string;
  ord: number;
  qfmt: string;
  afmt: string;
  bqfmt: string;
  bafmt: string;
  did: number | null;
}

export interface ApkgField {
  name: string;
  ord: number;
  sticky: boolean;
  rtl: boolean;
  font: string;
  size: number;
  media: any[];
}

export interface ApkgDeck {
  id: number;
  mod: number;
  name: string;
  usn: number;
  common: {
    desc: string;
    latexPre: string;
    latexPost: string;
    latexsvg: number;
    mid: number;
  };
  conf: number;
  newToday: [number, number];
  revToday: [number, number];
  lrnToday: [number, number];
  timeToday: [number, number];
}

export interface ApkgMedia {
  filename: string;
  data: Uint8Array;
}

export interface ParsedApkg {
  name: string;
  decks: Map<number, ApkgDeck>;
  models: Map<number, ApkgModel>;
  notes: Map<number, ApkgNote>;
  cards: Map<number, ApkgCard>;
  media: Map<string, Uint8Array>;
  collection: {
    conf: any;
    models: Record<string, ApkgModel>;
    decks: Record<string, ApkgDeck>;
    tags: any;
  };
}

export function parseApkg(buffer: Uint8Array, filename: string): ParsedApkg {
  const unzipped = unzipSync(buffer);
  
  const dbFile = unzipped['collection.anki21'] || unzipped['collection.anki2'];
  if (!dbFile) {
    throw new Error('No collection.anki21 or collection.anki2 found in .apkg file');
  }
  
  const mediaJson = unzipped['media'];
  const mediaMap = new Map<string, Uint8Array>();
  
  if (mediaJson) {
    try {
      const mediaIndex = JSON.parse(new TextDecoder().decode(mediaJson));
      for (const [num, name] of Object.entries(mediaIndex)) {
        const mediaData = unzipped[num];
        if (mediaData && typeof name === 'string') {
          mediaMap.set(name, mediaData);
        }
      }
    } catch (e) {
      // Media file might be empty or malformed
    }
  }
  
  const tempFile = join(tmpdir(), `anki-${randomBytes(8).toString('hex')}.db`);
  Bun.write(tempFile, dbFile);
  
  const db = new Database(tempFile);
  
  const notes = new Map<number, ApkgNote>();
  const notesStmt = db.prepare(`SELECT * FROM notes`);
  for (const note of notesStmt.all() as ApkgNote[]) {
    notes.set(note.id, note);
  }
  notesStmt.finalize();
  
  const cards = new Map<number, ApkgCard>();
  const cardsStmt = db.prepare(`SELECT * FROM cards`);
  for (const card of cardsStmt.all() as ApkgCard[]) {
    cards.set(card.id, card);
  }
  cardsStmt.finalize();
  
  const collectionStmt = db.prepare(`SELECT * FROM col`);
  const colRow = collectionStmt.get() as { id: number; crt: number; mod: number; scm: number; ver: number; dty: number; usn: number; ls: number; conf: string; models: string; decks: string; tags: string } | undefined;
  collectionStmt.finalize();
  
  if (!colRow) {
    db.close();
    Bun.file(tempFile).exists().then(exists => { if (exists) Bun.file(tempFile).delete(); });
    throw new Error('No collection found in .apkg file');
  }
  
  let collection: ParsedApkg['collection'];
  try {
    collection = {
      conf: JSON.parse(colRow.conf),
      models: JSON.parse(colRow.models),
      decks: JSON.parse(colRow.decks),
      tags: JSON.parse(colRow.tags)
    };
  } catch (e) {
    db.close();
    Bun.file(tempFile).exists().then(exists => { if (exists) Bun.file(tempFile).delete(); });
    throw new Error('Failed to parse collection JSON');
  }
  
  const models = new Map<number, ApkgModel>();
  for (const [id, model] of Object.entries(collection.models)) {
    models.set(parseInt(id), model as ApkgModel);
  }
  
  const decks = new Map<number, ApkgDeck>();
  for (const [id, deck] of Object.entries(collection.decks)) {
    decks.set(parseInt(id), deck as ApkgDeck);
  }
  
  db.close();
  Bun.file(tempFile).exists().then(exists => { if (exists) Bun.file(tempFile).delete(); });
  
  const name = filename.replace(/\.apkg$/i, '');
  
  return {
    name,
    decks,
    models,
    notes,
    cards,
    media: mediaMap,
    collection
  };
}

export function extractCardsFromApkg(apkg: ParsedApkg): Array<{
  cardId: number;
  deckName: string;
  front: string;
  back: string;
  fields: Record<string, string>;
}> {
  const results: Array<{
    cardId: number;
    deckName: string;
    front: string;
    back: string;
    fields: Record<string, string>;
  }> = [];
  
  for (const [cardId, card] of apkg.cards) {
    const note = apkg.notes.get(card.nid);
    if (!note) continue;
    
    const model = apkg.models.get(note.mid);
    if (!model) continue;
    
    const template = model.tmpls[card.ord];
    if (!template) continue;
    
    const fieldValues = note.flds.split('\x1f');
    const fields: Record<string, string> = {};
    for (let i = 0; i < model.flds.length && i < fieldValues.length; i++) {
      fields[model.flds[i].name] = fieldValues[i];
    }
    
    let front = template.qfmt;
    let back = template.afmt;
    
    for (const [fieldName, value] of Object.entries(fields)) {
      front = front.replace(new RegExp(`\\{\\{${fieldName}\\}\\}`, 'gi'), value);
      front = front.replace(new RegExp(`\\{\\{text:${fieldName}\\}\\}`, 'gi'), value);
      front = front.replace(new RegExp(`\\{\\{#${fieldName}\\}\\}`, 'gi'), value ? '' : '');
      front = front.replace(new RegExp(`\\{\\{/${fieldName}\\}\\}`, 'gi'), '');
      front = front.replace(new RegExp(`\\{\\{^${fieldName}\\}\\}`, 'gi'), value ? '' : '');
      
      back = back.replace(new RegExp(`\\{\\{${fieldName}\\}\\}`, 'gi'), value);
      back = back.replace(new RegExp(`\\{\\{text:${fieldName}\\}\\}`, 'gi'), value);
      back = back.replace(new RegExp(`\\{\\{#${fieldName}\\}\\}`, 'gi'), value ? '' : '');
      back = back.replace(new RegExp(`\\{\\{/${fieldName}\\}\\}`, 'gi'), '');
      back = back.replace(new RegExp(`\\{\\{^${fieldName}\\}\\}`, 'gi'), value ? '' : '');
    }
    
    front = front.replace(/\{\{FrontSide\}\}/gi, front);
    back = back.replace(/\{\{FrontSide\}\}/gi, front);
    
    front = front.replace(/\{\{[^}]+\}\}/g, '');
    back = back.replace(/\{\{[^}]+\}\}/g, '');
    
    front = cleanHtml(front);
    back = cleanHtml(back);
    
    const deck = apkg.decks.get(card.did);
    const deckName = deck?.name || apkg.name;
    
    results.push({
      cardId,
      deckName,
      front: front.trim(),
      back: back.trim(),
      fields
    });
  }
  
  return results;
}

function cleanHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\[sound:[^\]]+\]/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<img([^>]*)>/gi, (match, attrs) => {
      const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
      if (srcMatch) {
        return `<img src="${srcMatch[1]}">`;
      }
      return '[image]';
    })
    .replace(/<([a-z]+)[^>]*>\s*<\/\1>/gi, '')
    .replace(/<[^(img|br)]+>/gi, (match) => {
      if (match.startsWith('</') || match.startsWith('<img') || match.startsWith('<br')) return match;
      return '';
    });
}

export function getApkgMedia(apkg: ParsedApkg, filename: string): Uint8Array | undefined {
  return apkg.media.get(filename);
}

export function listApkgMedia(apkg: ParsedApkg): string[] {
  return Array.from(apkg.media.keys());
}
