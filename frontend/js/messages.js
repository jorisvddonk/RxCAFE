import { scrollToBottom } from './dom-utils.js';

// Import Lit widget components
import { RxMessageText } from '../widgets/rx-message-text.js';
import { RxMessageImage } from '../widgets/rx-message-image.js';
import { RxMessageAudio } from '../widgets/rx-message-audio.js';
import { RxMessageWeb } from '../widgets/rx-message-web.js';
import { RxMessageTool } from '../widgets/rx-message-tool.js';
import { RxMessageSystem } from '../widgets/rx-message-system.js';
import { RxMessageVisualization } from '../widgets/rx-message-visualization.js';
import { RxMessageCode } from '../widgets/rx-message-code.js';
import { RxMessageDiff } from '../widgets/rx-message-diff.js';
import { RxQuickResponses } from '../widgets/rx-quick-responses.js';
import { RxWeather } from '../widgets/rx-weather.js';

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
        const isCode = chunk.annotations?.['code.language'];
        const isDiff = chunk.annotations?.['diff.type'];
        
        if (!role && chunk.annotations?.['session.name']) {
            this.chat.chunkElements.set(chunk.id, null);
            return;
        }
        
        if (isVisualization) {
            this.addVisualizationMessage(chunk);
            return;
        }

        if (isDiff) {
            this.addDiffMessage(chunk);
            return;
        }

        if (isCode) {
            this.addCodeMessage(chunk);
            return;
        }

        const isWeather = chunk.annotations?.['weather.data'];
        if (isWeather) {
            this.addWeatherMessage(chunk);
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

                this.addQuickResponses(el, chunk);
            } else if (role === 'assistant') {
                if (chunk.annotations?.['tool.name']) {
                    this.addToolCallMessage(chunk);
                } else {
                    const el = this.chat.addMessage('assistant', chunk.content, chunk.id, chunk.annotations);
                    if (chunk.annotations?.['com.rxcafe.tool-detection']?.hasToolCalls) {
                        this.addToolCallIndicator(el, chunk.annotations['com.rxcafe.tool-detection'].toolCalls);
                    }
                    this.addQuickResponses(el, chunk);
                }
            }
        }
    }

    addCodeMessage(chunk) {
        this.chat.addRawChunk(chunk);
        
        const codeEl = document.createElement('rx-message-code');
        this.chat._elCounter++;
        codeEl.dataset.elId = this.chat._elCounter;
        codeEl.content = chunk.content || '';
        codeEl.language = chunk.annotations?.['code.language'] || '';
        codeEl.filename = chunk.annotations?.['code.filename'] || '';
        codeEl.chunkId = chunk.id;
        codeEl.role = chunk.annotations?.['chat.role'] || 'assistant';
        
        codeEl.addEventListener('code-contextmenu', (e) => {
            this.chat.showContextMenu(e.detail.originalEvent, e.detail.chunkId);
        });
        
        this.chat.messagesEl.appendChild(codeEl);
        this.chat.chunkElements.set(chunk.id, codeEl);
        scrollToBottom(this.chat.messagesEl);
    }

    addDiffMessage(chunk) {
        this.chat.addRawChunk(chunk);
        
        const diffEl = document.createElement('rx-message-diff');
        this.chat._elCounter++;
        diffEl.dataset.elId = this.chat._elCounter;
        diffEl.oldContent = chunk.annotations?.['diff.oldContent'] || '';
        diffEl.newContent = chunk.annotations?.['diff.newContent'] || chunk.content || '';
        diffEl.oldFilename = chunk.annotations?.['diff.oldFilename'] || '';
        diffEl.newFilename = chunk.annotations?.['diff.newFilename'] || '';
        diffEl.language = chunk.annotations?.['diff.language'] || '';
        diffEl.diffType = chunk.annotations?.['diff.type'] || 'unified';
        diffEl.chunkId = chunk.id;
        diffEl.role = chunk.annotations?.['chat.role'] || 'assistant';
        
        diffEl.addEventListener('diff-contextmenu', (e) => {
            this.chat.showContextMenu(e.detail.originalEvent, e.detail.chunkId);
        });
        
        this.chat.messagesEl.appendChild(diffEl);
        this.chat.chunkElements.set(chunk.id, diffEl);
        scrollToBottom(this.chat.messagesEl);
    }

    addVisualizationMessage(chunk) {
        const vizEl = document.createElement('rx-message-visualization');
        this.chat._elCounter++;
        vizEl.dataset.elId = this.chat._elCounter;

        // Store data on element immediately (before custom element upgrade)
        vizEl._initialData = {
            chunkId: chunk.id,
            agentName: chunk.annotations?.['visualizer.agent'] || 'Unknown',
            pipeline: chunk.annotations?.['visualizer.pipeline'],
            chunks: this.chat.rawChunks
        };

        vizEl.addEventListener('viz-contextmenu', (e) => {
            this.chat.showContextMenu(e.detail.originalEvent, e.detail.chunkId);
        });

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

    addWeatherMessage(chunk) {
        this.chat.addRawChunk(chunk);

        try {
            const weatherData = JSON.parse(chunk.content);
            const location = chunk.annotations?.['weather.location'] || '';
            const timezone = chunk.annotations?.['weather.timezone'] || '';

            const weatherEl = document.createElement('rx-weather');
            this.chat._elCounter++;
            weatherEl.dataset.elId = this.chat._elCounter;
            weatherEl.weatherData = weatherData;
            weatherEl.location = location;
            weatherEl.timezone = timezone;
            weatherEl.chunkId = chunk.id;

            this.chat.messagesEl.appendChild(weatherEl);
            this.chat.chunkElements.set(chunk.id, weatherEl);
            scrollToBottom(this.chat.messagesEl);
        } catch (e) {
            console.error('[RXCAFE] Failed to parse weather data:', e);
            this.addMessage('assistant', chunk.content, chunk.id, chunk.annotations);
        }
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

    addQuickResponses(messageEl, chunk) {
        const quickResponses = chunk.annotations?.['com.rxcafe.quickResponses'];
        if (!quickResponses || !Array.isArray(quickResponses) || quickResponses.length === 0) {
            return;
        }

        // Prevent duplicate quick responses for the same chunk
        const existingId = 'quick-responses-' + chunk.id;
        if (document.getElementById(existingId)) {
            return;
        }

        const quickResponsesEl = document.createElement('rx-quick-responses');
        quickResponsesEl.responses = quickResponses;
        quickResponsesEl.disabled = !this.chat.sessionId || this.chat.isGenerating;
        quickResponsesEl.id = existingId;

        quickResponsesEl.addEventListener('quick-response', (e) => {
            if (this.chat.messageInput) {
                this.chat.messageInput.value = e.detail.response;
                this.chat.sendMessage();
            }
        });

        this.chat.messagesEl.appendChild(quickResponsesEl);
        this.chat.scrollToBottom();
    }

    updateQuickResponsesState() {
        const allQuickResponses = this.chat.messagesEl?.querySelectorAll('rx-quick-responses');
        if (allQuickResponses) {
            allQuickResponses.forEach(el => {
                el.disabled = !this.chat.sessionId || this.chat.isGenerating;
            });
        }
    }
}