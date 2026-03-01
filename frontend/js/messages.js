import { scrollToBottom } from './dom-utils.js';

// Import Lit widget components
import { RxMessageText } from '../widgets/rx-message-text.js';
import { RxMessageImage } from '../widgets/rx-message-image.js';
import { RxMessageAudio } from '../widgets/rx-message-audio.js';
import { RxMessageWeb } from '../widgets/rx-message-web.js';
import { RxMessageTool } from '../widgets/rx-message-tool.js';
import { RxMessageSystem } from '../widgets/rx-message-system.js';
import { RxMessageVisualization } from '../widgets/rx-message-visualization.js';

export class MessagesManager {
    constructor(chat) {
        this.chat = chat;
    }

    renderChunk(chunk) {
        const role = chunk.annotations?.['chat.role'];
        const isWeb = chunk.producer === 'com.rxcafe.web-fetch' || chunk.annotations?.['web.source-url'];
        const isSystem = role === 'system';
        const isTelegram = chunk.annotations?.['client.type'] === 'telegram';
        const isVisualization = chunk.annotations?.['visualizer.type'] === 'rx-marbles';
        
        if (!role && chunk.annotations?.['session.name']) {
            this.chat.chunkElements.set(chunk.id, null);
            return;
        }
        
        if (isVisualization) {
            this.addVisualizationMessage(chunk);
            return;
        }

        console.log(`[RXCAFE] renderChunk id=${chunk.id} role=${role} content="${String(chunk.content ?? '').slice(0,60)}"`);
        
        if (chunk.contentType === 'binary') {
            const mimeType = chunk.content?.mimeType || '';
            console.log(`[RXCAFE] Rendering binary chunk, mimeType: ${mimeType}, role: ${role}`);
            if (mimeType.startsWith('image/')) {
                console.log('[RXCAFE] Calling addImageMessage');
                this.addImageMessage(role || 'assistant', chunk);
            } else if (mimeType.startsWith('audio/')) {
                console.log('[RXCAFE] Calling addAudioMessage');
                this.addAudioMessage(role || 'assistant', chunk);
            } else {
                console.warn('[RXCAFE] Unsupported binary chunk', chunk);
            }
            return;
        }

        if (isWeb) {
            this.addWebChunk(chunk);
        } else if (isSystem) {
            this.addSystemChunk(chunk, chunk.content);
        } else if (chunk.contentType === 'text') {
            if (role === 'user') {
                const el = this.chat.addMessage('user', chunk.content, chunk.id, chunk.annotations);
                
                if (isTelegram) {
                    this.addTelegramLabel(el);
                }

                if (chunk.annotations && chunk.annotations['com.rxcafe.example.sentiment']) {
                    this.chat.updateSentiment(el, chunk.annotations['com.rxcafe.example.sentiment']);
                }
            } else if (role === 'assistant') {
                if (chunk.annotations?.['tool.name']) {
                    this.addToolCallMessage(chunk);
                } else {
                    const el = this.chat.addMessage('assistant', chunk.content, chunk.id, chunk.annotations);
                    if (chunk.annotations?.['com.rxcafe.tool-detection']?.hasToolCalls) {
                        this.addToolCallIndicator(el, chunk.annotations['com.rxcafe.tool-detection'].toolCalls);
                    }
                }
            }
        }
    }

    addVisualizationMessage(chunk) {
        const vizEl = document.createElement('rx-message-visualization');
        this.chat._elCounter++;
        vizEl.dataset.elId = this.chat._elCounter;
        vizEl.chunkId = chunk.id;
        vizEl.agentName = chunk.annotations['visualizer.agent'];
        vizEl.pipeline = chunk.annotations['visualizer.pipeline'];
        vizEl.chunks = this.chat.rawChunks;
        
        vizEl.addEventListener('contextmenu', (e) => this.chat.showContextMenu(e, chunk.id));
        
        this.chat.messagesEl.appendChild(vizEl);
        this.chat.chunkElements.set(chunk.id, vizEl);
        scrollToBottom(this.chat.messagesEl);
    }

    addTelegramLabel(messageEl) {
        if (!messageEl || messageEl.tagName !== 'RX-MESSAGE-TEXT') return;
        const annotations = messageEl.annotations || {};
        if (!annotations['client.type']) {
            messageEl.annotations = { ...annotations, 'client.type': 'telegram' };
        }
    }

    addToolCallMessage(chunk) {
        const toolName = chunk.annotations?.['tool.name'];
        const toolResult = chunk.annotations?.['tool.results'];
        const toolDetection = chunk.annotations?.['com.rxcafe.tool-detection'];

        const toolEl = document.createElement('rx-message-tool');
        this.chat._elCounter++;
        toolEl.dataset.elId = this.chat._elCounter;
        toolEl.toolName = toolName || 'Unknown Tool';
        toolEl.toolResult = toolResult;
        toolEl.toolCalls = toolDetection?.toolCalls || [];
        toolEl.content = chunk.content || '';
        toolEl.chunkId = chunk.id;

        this.chat.messagesEl.appendChild(toolEl);
        this.chat.chunkElements.set(chunk.id, toolEl);
        scrollToBottom(this.chat.messagesEl);
    }

    addToolCallIndicator(messageEl, toolCalls) {
        if (!messageEl || !toolCalls?.length || messageEl.tagName !== 'RX-MESSAGE-TEXT') return;

        const annotations = messageEl.annotations || {};
        const existingIndicators = annotations['toolCallIndicators'] || [];
        messageEl.annotations = { 
            ...annotations, 
            'toolCallIndicators': [...existingIndicators, ...toolCalls]
        };
    }

    addSystemChunk(chunk, prompt) {
        this.chat.addRawChunk(chunk);
        
        const systemEl = document.createElement('rx-message-system');
        systemEl.content = prompt;
        systemEl.chunkId = chunk.id;
        systemEl.type = 'system-prompt';
        
        this.chat.messagesEl.appendChild(systemEl);
        this.chat.chunkElements.set(chunk.id, systemEl);
        scrollToBottom(this.chat.messagesEl);
    }

    addWebChunk(chunk) {
        this.chat.addRawChunk(chunk);
        
        const isTrusted = chunk.annotations?.['security.trust-level']?.trusted === true;
        const sourceUrl = chunk.annotations?.['web.source-url'] || 'Unknown source';
        
        const webEl = document.createElement('rx-message-web');
        webEl.content = chunk.content;
        webEl.sourceUrl = sourceUrl;
        webEl.trusted = isTrusted;
        webEl.chunkId = chunk.id;
        
        webEl.addEventListener('trust-toggle', (e) => {
            this.chat.toggleTrustFromButton(e.detail.chunkId, e.detail.trusted);
        });
        
        this.chat.messagesEl.appendChild(webEl);
        this.chat.chunkElements.set(chunk.id, webEl);
        scrollToBottom(this.chat.messagesEl);
        
        if (!isTrusted) {
            this.chat.addSystemMessage('Web content added but NOT trusted. Right-click and select "Trust Chunk" to include in LLM context, or click the Trust button.');
        }
    }

    addImageMessage(role, chunk) {
        if (!chunk.content || !chunk.content.data) {
            console.error('[RXCAFE] Binary chunk missing data', chunk);
            return;
        }
        const { data, mimeType } = chunk.content;
        
        let uint8;
        if (data instanceof Uint8Array) {
            uint8 = data;
        } else if (Array.isArray(data)) {
            uint8 = new Uint8Array(data);
        } else if (typeof data === 'object' && data !== null) {
            if (data.type === 'Buffer' && Array.isArray(data.data)) {
                uint8 = new Uint8Array(data.data);
            } else {
                uint8 = new Uint8Array(Object.values(data));
            }
        } else {
            console.error('[RXCAFE] Invalid image data format', data);
            return;
        }

        const blob = new Blob([uint8], { type: mimeType });
        const url = URL.createObjectURL(blob);
        
        const imageEl = document.createElement('rx-message-image');
        this.chat._elCounter++;
        imageEl.dataset.elId = this.chat._elCounter;
        imageEl.role = role;
        imageEl.src = url;
        imageEl.alt = chunk.annotations?.['image.description'] || 'Generated image';
        imageEl.description = chunk.annotations?.['image.description'] || '';
        imageEl.chunkId = chunk.id;
        
        this.chat.messagesEl.appendChild(imageEl);
        this.chat.chunkElements.set(chunk.id, imageEl);
        scrollToBottom(this.chat.messagesEl);
    }

    addAudioMessage(role, chunk) {
        if (!chunk.content || !chunk.content.data) {
            console.error('[RXCAFE] Binary chunk missing data', chunk);
            return;
        }
        const { data, mimeType } = chunk.content;
        
        let uint8;
        if (data instanceof Uint8Array) {
            uint8 = data;
        } else if (Array.isArray(data)) {
            uint8 = new Uint8Array(data);
        } else if (typeof data === 'object' && data !== null) {
            if (data.type === 'Buffer' && Array.isArray(data.data)) {
                uint8 = new Uint8Array(data.data);
            } else {
                uint8 = new Uint8Array(Object.values(data));
            }
        } else {
            console.error('[RXCAFE] Invalid audio data format', data);
            return;
        }

        const blob = new Blob([uint8], { type: mimeType });
        const url = URL.createObjectURL(blob);
        console.log(`[RXCAFE] Created audio blob URL: ${url} (size: ${blob.size} bytes, type: ${mimeType})`);
        
        const audioEl = document.createElement('rx-message-audio');
        this.chat._elCounter++;
        audioEl.dataset.elId = this.chat._elCounter;
        audioEl.role = role;
        audioEl.src = url;
        audioEl.description = chunk.annotations?.['audio.description'] || '';
        audioEl.chunkId = chunk.id;
        
        this.chat.messagesEl.appendChild(audioEl);
        this.chat.chunkElements.set(chunk.id, audioEl);
        scrollToBottom(this.chat.messagesEl);
    }

    addMessage(role, content, chunkId = null, annotations = {}) {
        const messageEl = this.chat.createMessageElement(role, content, annotations);
        console.log(`[RXCAFE] addMessage elId=${messageEl.dataset.elId} role=${role} chunkId=${chunkId}`);
        if (chunkId) {
            messageEl.dataset.chunkId = chunkId;
            this.chat.chunkElements.set(chunkId, messageEl);
        }
        this.chat.messagesEl.appendChild(messageEl);
        scrollToBottom(this.chat.messagesEl);
        return messageEl;
    }

    updateSentiment(messageEl, sentiment) {
        if (!messageEl || !sentiment) return;
        console.log('[RXCAFE] updateSentiment called for element:', messageEl.dataset.elId, sentiment);
        
        if (messageEl.tagName === 'RX-MESSAGE-TEXT') {
            const annotations = messageEl.annotations || {};
            messageEl.annotations = { ...annotations, 'com.rxcafe.example.sentiment': sentiment };
        }
    }
}
