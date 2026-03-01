import type { AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { annotateChunk } from '../lib/chunk.js';
import { filter, map, Observable } from '../lib/stream.js';

export interface ParsedMarkdownItem {
  type: 'text' | 'quote' | 'bold' | 'emphasis' | 'code' | 'tool_call' | 'tool_result' | 'reasoning';
  content: string;
  start: number;
  end: number;
}

const TOOL_CALL_TAG = '<|tool_call|>';
const TOOL_CALL_END_TAG = '<|tool_call_end|>';
const TOOL_RESULT_TAG = '<|tool_result|>';
const TOOL_RESULT_END_TAG = '<|tool_result_end|>';
const REASONING_TAG = '<reasoning>';
const REASONING_END_TAG = '</reasoning>';

export function parseMarkdownForVoice(session: AgentSessionContext) {
  return (source: Observable<Chunk>): Observable<Chunk> => {
    return new Observable(subscriber => {
      const subscription = source.subscribe({
        next: (chunk: Chunk) => {
          if (
            chunk.contentType !== 'text' ||
            typeof chunk.content !== 'string'
          ) {
            subscriber.next(chunk);
            return;
          }

          const text = chunk.content;
          const items = parseMarkdown(text);

          if (items.length === 0) {
            subscriber.next(chunk);
            return;
          }

          const annotatedChunk = annotateChunk(chunk, 'voice.parsed', items);
          subscriber.next(annotatedChunk);
        },
        error: (err) => subscriber.error(err),
        complete: () => subscriber.complete()
      });

      return () => subscription.unsubscribe();
    });
  };
}

function parseMarkdown(text: string): ParsedMarkdownItem[] {
  const items: ParsedMarkdownItem[] = [];
  let pos = 0;

  while (pos < text.length) {
    const callStart = text.indexOf(TOOL_CALL_TAG, pos);
    const resultStart = text.indexOf(TOOL_RESULT_TAG, pos);
    const reasoningStart = text.indexOf(REASONING_TAG, pos);

    const earliest = Math.min(
      callStart !== -1 ? callStart : Infinity,
      resultStart !== -1 ? resultStart : Infinity,
      reasoningStart !== -1 ? reasoningStart : Infinity
    );

    if (earliest === Infinity) {
      const remaining = text.slice(pos);
      if (remaining) {
        items.push(...parsePlainMarkdown(remaining, pos));
      }
      break;
    }

    if (earliest === callStart) {
      const plainText = text.slice(pos, callStart);
      if (plainText) {
        items.push(...parsePlainMarkdown(plainText, pos));
      }

      const callEnd = text.indexOf(TOOL_CALL_END_TAG, callStart);
      if (callEnd === -1) {
        items.push(...parsePlainMarkdown(text.slice(callStart), pos));
        break;
      }

      const json = text.slice(callStart + TOOL_CALL_TAG.length, callEnd);
      try {
        const toolCall = JSON.parse(json);
        items.push({
          type: 'tool_call',
          content: JSON.stringify(toolCall),
          start: callStart,
          end: callEnd + TOOL_CALL_END_TAG.length
        });
      } catch {
        items.push(...parsePlainMarkdown(text.slice(callStart, callEnd + TOOL_CALL_END_TAG.length), callStart));
      }
      pos = callEnd + TOOL_CALL_END_TAG.length;
    } else if (earliest === resultStart) {
      const plainText = text.slice(pos, resultStart);
      if (plainText) {
        items.push(...parsePlainMarkdown(plainText, pos));
      }

      const resultEnd = text.indexOf(TOOL_RESULT_END_TAG, resultStart);
      if (resultEnd === -1) {
        items.push(...parsePlainMarkdown(text.slice(resultStart), pos));
        break;
      }

      const json = text.slice(resultStart + TOOL_RESULT_TAG.length, resultEnd);
      try {
        const toolResult = JSON.parse(json);
        items.push({
          type: 'tool_result',
          content: JSON.stringify(toolResult),
          start: resultStart,
          end: resultEnd + TOOL_RESULT_END_TAG.length
        });
      } catch {
        items.push(...parsePlainMarkdown(text.slice(resultStart, resultEnd + TOOL_RESULT_END_TAG.length), resultStart));
      }
      pos = resultEnd + TOOL_RESULT_END_TAG.length;
    } else if (earliest === reasoningStart) {
      const plainText = text.slice(pos, reasoningStart);
      if (plainText) {
        items.push(...parsePlainMarkdown(plainText, pos));
      }

      const reasoningEnd = text.indexOf(REASONING_END_TAG, reasoningStart);
      if (reasoningEnd === -1) {
        items.push(...parsePlainMarkdown(text.slice(reasoningStart), pos));
        break;
      }

      const reasoningContent = text.slice(reasoningStart + REASONING_TAG.length, reasoningEnd);
      items.push({
        type: 'reasoning',
        content: reasoningContent,
        start: reasoningStart,
        end: reasoningEnd + REASONING_END_TAG.length
      });
      pos = reasoningEnd + REASONING_END_TAG.length;
    }
  }

  return items;
}

function parsePlainMarkdown(text: string, offset: number): ParsedMarkdownItem[] {
  const items: ParsedMarkdownItem[] = [];
  let pos = 0;

  const patterns: Array<{ regex: RegExp; type: ParsedMarkdownItem['type'] }> = [
    { regex: /"([^"]*)"/g, type: 'quote' },
    { regex: /\*\*([^*]*)\*\*/g, type: 'bold' },
    { regex: /\*([^*]*)\*/g, type: 'emphasis' },
    { regex: /(?<!\w)_([^_]+)_(?!\w)/g, type: 'emphasis' },
    { regex: /`([^`]*)`/g, type: 'code' }
  ];

  while (pos < text.length) {
    let earliestMatch: { match: RegExpExecArray; type: ParsedMarkdownItem['type']; regex: RegExp } | null = null;
    let earliestIndex = text.length;

    for (const { regex, type } of patterns) {
      regex.lastIndex = pos;
      const match = regex.exec(text);
      if (match && match.index < earliestIndex) {
        earliestMatch = { match, type, regex };
        earliestIndex = match.index;
      }
    }

    if (!earliestMatch) {
      const plain = text.slice(pos);
      if (plain) {
        items.push({
          type: 'text',
          content: plain,
          start: offset + pos,
          end: offset + text.length
        });
      }
      break;
    }

    if (earliestMatch.match.index > pos) {
      const plain = text.slice(pos, earliestMatch.match.index);
      items.push({
        type: 'text',
        content: plain,
        start: offset + pos,
        end: offset + earliestMatch.match.index
      });
    }

    items.push({
      type: earliestMatch.type,
      content: earliestMatch.match[1],
      start: offset + earliestMatch.match.index,
      end: offset + earliestMatch.regex.lastIndex
    });

    pos = earliestMatch.regex.lastIndex;
  }

  return items;
}

export default parseMarkdownForVoice;
