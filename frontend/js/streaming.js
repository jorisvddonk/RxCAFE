export class StreamingManager {
    constructor(chat) {
        this.chat = chat;
        this.eventSource = null;
        this.reconnectTimer = null;
    }

    connect(sessionId) {
        this.disconnect();
        const url = this.chat.apiUrl(`/api/session/${sessionId}/stream`);
        const es = new EventSource(url);
        this.eventSource = es;

        es.onopen = () => {
            console.log(`[RXCAFE] SSE connected for session ${sessionId}`);
        };

        es.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleMessage(data);
            } catch (e) {
                console.error('[RXCAFE] SSE parse error:', e, event.data);
            }
        };

        es.onerror = (err) => {
            if (es !== this.eventSource) return;
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
            this.eventSource.close();
            this.eventSource = null;
        }
    }

    scheduleReconnect(sessionId) {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.chat.sessionId === sessionId) {
                this.connect(sessionId);
            }
        }, 3000);
    }

    handleMessage(data) {
        const chat = this.chat;

        if (data.type === 'chunk') {
            const chunk = data.chunk;
            const role = chunk.annotations?.['chat.role'];

            const chunkEvent = new CustomEvent('rxcafe:chunk', {
                detail: { chunk, sessionId: chat.sessionId, uiMode: chat.uiMode },
                bubbles: true,
                composed: true
            });
            document.dispatchEvent(chunkEvent);

            if (chunk.contentType === 'null' && chunk.annotations?.['config.type'] === 'runtime') {
                chat.backend = chunk.annotations['config.backend'] || chat.backend;
                chat.model = chunk.annotations['config.model'] || chat.model;
                chat.updateHeaderInfo();
            }

            if (chunk.annotations?.['session.name']) {
                const newName = chunk.annotations['session.name'];
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
                    if (chunk.annotations['com.rxcafe.example.sentiment']) {
                        chat.updateSentiment(el, chunk.annotations['com.rxcafe.example.sentiment']);
                    }
                    if (chunk.contentType === 'text') {
                        chat.updateMessageContent(el, chunk.content, chunk.annotations);
                    }
                }
                chat.addRawChunk(chunk);
                return;
            }

            if (role === 'user' && chat._pendingUserMsg) {
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
            const isChess = chunk.annotations?.['chess.fen'];
            const isAssistantText = role === 'assistant' && chunk.contentType === 'text' && !isFromConnectedAgent && !isChess;

            if (isAssistantText) {
                const assistantEl = chat.createMessageElement('assistant', chunk.content, chunk.annotations);
                chat.messagesEl.appendChild(assistantEl);
                chat.scrollToBottom();

                chat.currentMessageEl = assistantEl;
                assistantEl.dataset.chunkId = chunk.id;
                chat.chunkElements.set(chunk.id, assistantEl);
                chat.updateMessageContent(assistantEl, chunk.content, chunk.annotations);
                chat.messagesManager.addQuickResponses(assistantEl, chunk);
                chat.addRawChunk(chunk);
                chat.updateInspector();
                return;
            }

            chat.addRawChunk(chunk);
            chat.renderChunk(chunk);
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

                    const chunkId = data.chunkId;
                    let assistantEl = chat.currentMessageEl;

                    if (!assistantEl || assistantEl.tagName !== 'RX-MESSAGE-TEXT' || assistantEl.role !== 'assistant') {
                        if (chunkId && chat.chunkElements.has(chunkId)) {
                            assistantEl = chat.chunkElements.get(chunkId);
                            chat.currentMessageEl = assistantEl;
                        }
                    }

                    if (!assistantEl || assistantEl.tagName !== 'RX-MESSAGE-TEXT' || assistantEl.role !== 'assistant') {
                        assistantEl = chat.createMessageElement('assistant', '');
                        assistantEl.classList.add('streaming');
                        chat.messagesEl.appendChild(assistantEl);
                        chat.scrollToBottom();

                        if (chunkId) {
                            assistantEl.dataset.chunkId = chunkId;
                            chat.chunkElements.set(chunkId, assistantEl);
                        }
                        chat.currentMessageEl = assistantEl;
                    }

                    const annotations = assistantEl?.dataset.annotations
                        ? JSON.parse(assistantEl.dataset.annotations)
                        : {};
                    chat.updateMessageContent(assistantEl, chat.currentContent, annotations);
                }
                break;
            case 'error':
                if (chat.currentMessageEl) {
                    chat.showErrorInMessage(chat.currentMessageEl, data.error);
                }
                break;
            case 'finish':
            case 'done':
                break;
        }
    }
}
