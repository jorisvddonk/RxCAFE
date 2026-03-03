export class StreamingManager {
    constructor(chat) {
        this.chat = chat;
        this.eventSource = null;
        this.reconnectTimer = null;
    }

    connect(sessionId) {
        this.disconnect();
        const url = this.chat.apiUrl(`/api/session/${sessionId}/stream`);
        console.log(`[RXCAFE] Opening EventSource: ${url}`);
        const es = new EventSource(url);
        this.eventSource = es;

        es.onopen = () => {
            console.log(`[RXCAFE] SSE connected for session ${sessionId}`);
        };

        es.onmessage = (event) => {
            console.log(`[RXCAFE] SSE raw event:`, event.data.slice(0, 120));
            try {
                const data = JSON.parse(event.data);
                console.log(`[RXCAFE] SSE parsed type="${data.type}"`, data.type === 'chunk' ? `id=${data.chunk?.id}` : '');
                this.handleMessage(data);
            } catch (e) {
                console.error('[RXCAFE] SSE parse error:', e, event.data);
            }
        };

        es.onerror = (err) => {
            if (es !== this.eventSource) return;
            console.warn(`[RXCAFE] SSE error/disconnect for session ${sessionId}`, err);
            es.close();
            this.eventSource = null;
            this.scheduleReconnect(sessionId);
        };
    }

    disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.eventSource) {
            console.log(`[RXCAFE] disconnectStream: closing EventSource`);
            this.eventSource.close();
            this.eventSource = null;
        }
    }

    scheduleReconnect(sessionId) {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.chat.sessionId === sessionId) {
                console.log(`[RXCAFE] Reconnecting SSE for ${sessionId}...`);
                this.connect(sessionId);
            }
        }, 3000);
    }

    handleMessage(data) {
        const chat = this.chat;
        
        if (data.type === 'chunk') {
            const chunk = data.chunk;
            const role = chunk.annotations?.['chat.role'];

            if (chunk.contentType === 'null' && chunk.annotations?.['config.type'] === 'runtime') {
                chat.backend = chunk.annotations['config.backend'] || chat.backend;
                chat.model = chunk.annotations['config.model'] || chat.model;
                console.log(`[RXCAFE] Runtime config updated: backend=${chat.backend}, model=${chat.model}`);
                chat.updateHeaderInfo();
            }

            if (chunk.annotations?.['session.name']) {
                const newName = chunk.annotations['session.name'];
                console.log(`[RXCAFE] Session renamed to: ${newName}`);
                const session = chat.knownSessions.find(s => s.id === chat.sessionId);
                if (session) {
                    session.displayName = newName;
                    chat.renderSidebarSessionList();
                    chat.updateHeaderInfo();
                }
            }

            if (chat.chunkElements.has(chunk.id)) {
                const el = chat.chunkElements.get(chunk.id);
                if (el) {
                    console.log(`[RXCAFE] SSE: Updating existing chunk UI:`, chunk.id);
                    if (chunk.annotations['com.rxcafe.example.sentiment']) {
                        chat.updateSentiment(el, chunk.annotations['com.rxcafe.example.sentiment']);
                    }
                    if (chunk.contentType === 'text' && !el.classList?.contains('streaming')) {
                        chat.updateMessageContent(el, chunk.content, chunk.annotations);
                        if (chunk.annotations['com.rxcafe.example.sentiment']) {
                            chat.updateSentiment(el, chunk.annotations['com.rxcafe.example.sentiment']);
                        }
                    }
                }
                chat.addRawChunk(chunk);
                return;
            }

            if (role === 'user' && chat._pendingUserMsg) {
                console.log(`[RXCAFE] SSE user chunk claimed by pending element elId=${chat._pendingUserMsg.dataset.elId}, registering id:`, chunk.id);
                chat._pendingUserMsg.dataset.chunkId = chunk.id;
                chat.chunkElements.set(chunk.id, chat._pendingUserMsg);
                if (chunk.annotations['com.rxcafe.example.sentiment']) {
                    chat.updateSentiment(chat._pendingUserMsg, chunk.annotations['com.rxcafe.example.sentiment']);
                }
                chat._pendingUserMsg = null;
                chat.addRawChunk(chunk);
                chat.updateInspector();
                return;
            }

            const isFromConnectedAgent = chunk.producer?.startsWith('com.observablecafe.connected-agent');
            const assistantEl = (chat.currentMessageEl?.dataset.pendingAssistant ? chat.currentMessageEl : null) 
                                || (chat._lastAssistantEl?.dataset.pendingAssistant ? chat._lastAssistantEl : null);

            if (role === 'assistant' && assistantEl && chunk.contentType === 'text' && !isFromConnectedAgent) {
                console.log(`[RXCAFE] SSE assistant chunk claimed by element elId=${assistantEl.dataset.elId}, registering id:`, chunk.id);
                assistantEl.dataset.chunkId = chunk.id;
                chat.chunkElements.set(chunk.id, assistantEl);
                assistantEl.dataset.annotations = JSON.stringify(chunk.annotations || {});
                chat.updateMessageContent(assistantEl, chunk.content, chunk.annotations);
                delete assistantEl.dataset.pendingAssistant;
                if (assistantEl === chat._lastAssistantEl) chat._lastAssistantEl = null;
                chat.addRawChunk(chunk);
                chat.updateInspector();
                return;
            }

            console.log(`[RXCAFE] New chunk from stream, rendering:`, chunk.id, chunk.contentType, chunk.content?.mimeType);
            chat.addRawChunk(chunk);
            chat.renderChunk(chunk);
            
            // Pass dice-specific chunks to dice controller if in dice mode
            if (chat.diceUIController && chat.uiMode === 'game-dice') {
                chat.diceUIController.handleChunk(chunk);
            }
            
            chat.updateInspector();
        }
    }

    handleStreamData(data) {
        const chat = this.chat;
        switch (data.type) {
            case 'user':
                if (data.chunk) chat.addRawChunk(data.chunk);
                break;
            case 'chunk':
                if (data.chunk) chat.addRawChunk(data.chunk);
                break;
            case 'token':
                if (data.token) {
                    chat.currentContent += data.token;
                    const annotations = chat.currentMessageEl?.dataset.annotations 
                        ? JSON.parse(chat.currentMessageEl.dataset.annotations) 
                        : {};
                    chat.updateMessageContent(chat.currentMessageEl, chat.currentContent, annotations);
                }
                break;
            case 'error':
                chat.showErrorInMessage(chat.currentMessageEl, data.error);
                break;
            case 'finish':
            case 'done':
                break;
        }
    }
}
