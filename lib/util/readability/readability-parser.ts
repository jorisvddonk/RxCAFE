import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

/**
 * Fetches a URL and parses its content using Readability to return article only.
 * @param url 
 * @returns 
 * @throws Error
 */
export async function parse(url: string) {
    const response = await fetch(url);
    const data = await response.text();
    const doc = new JSDOM(data, { url });

    const selectors = [
        '.tags',
        '.related',
        '.comments',
        'nav',
        'footer',
        '[data-sentry-component="MetaFooter"]',
        '[data-sentry-component="TagList"]',
        '[data-sentry-component*="Footer"]',
        '[data-sentry-component*="Meta"]',
        '.button',
        '.portable-archive-list'
    ];
    doc.window.document.querySelectorAll(selectors.join(",")).forEach(el => el.remove());

    let reader = new Readability(doc.window.document);
    let article = reader.parse();

    if (article === null || article.content === null) {
        throw new Error("Article (content) is null");
    }

    const doc2 = new JSDOM(article.content, { url });

    doc2.window.document.querySelectorAll(selectors.join(",")).forEach(el => el.remove());

    const ps = Array.from(doc2.window.document.body.querySelectorAll('p'));
    const paragraphs = ps.map(p => p.textContent.trim()).filter(p => p.length > 1);
    const text = paragraphs.join('\n\n').replace(/\n{3,}/g, '\n\n');
    return {
        paragraphs,
        text,
        content: article.content
    }
}