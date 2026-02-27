import type { AgentEvaluator, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { createTextChunk } from '../lib/chunk.js';
import { Observable } from '../lib/stream.js';

export interface RssItem {
  title: string;
  link: string;
  description: string;
}

/**
 * Fetches and parses a minimal RSS feed using regex.
 */
export async function fetchRss(url: string): Promise<RssItem[]> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'RXCAFE-RSS-Bot/1.0' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();

    const items: RssItem[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(xml)) !== null && items.length < 10) {
      const itemXml = match[1];
      const title = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] || 'No Title';
      const link = itemXml.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '';
      const description = itemXml.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1] || '';
      
      items.push({ 
        title: cleanXmlEntities(title), 
        link: link.trim(), 
        description: cleanXmlEntities(description).slice(0, 500) 
      });
    }

    return items;
  } catch (error) {
    console.error(`[RssEvaluator] Fetch failed for ${url}:`, error);
    return [];
  }
}

function cleanXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, ''); // Strip any remaining tags
}

/**
 * Higher-order function to summarize RSS feeds.
 */
export function summarizeRss(session: AgentSessionContext) {
  const evaluator = session.createLLMChunkEvaluator({ 
    temperature: 0.5, 
    maxTokens: 1000 
  });

  return async (feedUrl: string): Promise<string> => {
    const items = await fetchRss(feedUrl);
    if (items.length === 0) return "Failed to fetch or parse RSS feed.";

    const feedText = items.map((item, i) => `${i+1}. ${item.title}\n   ${item.description}`).join('\n\n');
    
    const prompt = `You are a professional news curator. Summarize the following RSS feed items into a concise, engaging daily briefing. 

Feed Content:
${feedText}

Briefing:`;

    const promptChunk = createTextChunk(prompt, 'com.rxcafe.rss.summarizer', {
      'llm.full-prompt': true
    });

    let summary = '';
    try {
      for await (const tokenChunk of evaluator.evaluateChunk(promptChunk)) {
        if (tokenChunk.contentType === 'text') {
          summary += tokenChunk.content;
        }
      }
      return summary;
    } catch (err) {
      console.error('[RssEvaluator] Summary LLM failed:', err);
      return "Failed to generate summary.";
    }
  };
}
