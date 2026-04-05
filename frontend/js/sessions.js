export class SessionsManager {
    constructor(chat) {
        this.chat = chat;
        this.sessionUpdatesEventSource = null;
        this.connectToSessionUpdates();
    }

    async loadSessions() {
        console.log('[RXCAFE] loadSessions called');
        try {
            const response = await fetch(this.chat.apiUrl('/api/sessions'));
            const data = await response.json();
            console.log('[RXCAFE] loadSessions data:', data);
            
            if (data.sessions) {
                this.chat.knownSessions = data.sessions.map(s => ({
                    ...s,
                    messageCount: s.messageCount || 0,
                    newMessageCount: 0
                }));
                this.chat.renderSidebarSessionList();

                if (this.chat.sessionsModal.style.display === 'flex') {
                    console.log('[RXCAFE] Updating session list in modal');
                    this.chat.renderSessionList();
                }
                
                if (!this.chat.sessionId && data.sessions.length > 0) {
                    const hashId = window.location.hash.substring(1);
                    const sessionInHash = data.sessions.find(s => s.id === hashId);

                    if (sessionInHash) {
                        console.log(`[RXCAFE] Auto-connecting to session from URL hash: ${hashId}`);
                        await this.chat.switchToSession(hashId);
                    } else {
                        const recentSession = data.sessions.find(s => !s.isBackground) || data.sessions[0];
                        if (recentSession) {
                            await this.chat.switchToSession(recentSession.id);
                        }
                    }

                    // If still no session, show quickies view
                    if (!this.chat.sessionId && window.quickiesManager) {
                        window.quickiesManager.onSessionChange(null);
                    }
                }
            }
        } catch (error) {
            console.error('Failed to load sessions:', error);
        }
    }

    async switchToSession(sessionId) {
        console.log(`[RXCAFE] switchToSession: ${sessionId}`);
        this.chat.disconnectStream();

        if (window.location.hash.substring(1) !== sessionId) {
            window.location.hash = sessionId;
        }

        try {
            console.log(`[RXCAFE] Fetching history for ${sessionId}...`);
            const response = await fetch(this.chat.apiUrl(`/api/session/${sessionId}/history?binaryRefs=1`));
            const data = await response.json();
            console.log(`[RXCAFE] History response:`, data.sessionId, `chunks:`, data.chunks?.length ?? 0);
            
            if (data.sessionId) {
                this.chat.sessionId = data.sessionId;
                
                const sessionInfo = this.chat.knownSessions.find(s => s.id === sessionId);
                if (sessionInfo) {
                    this.chat.agentName = sessionInfo.agentName;
                    this.chat.isBackground = sessionInfo.isBackground;
                    if (data.displayName) sessionInfo.displayName = data.displayName;
                }
                
                let backend = null;
                let model = null;
                if (data.chunks) {
                    for (let i = data.chunks.length - 1; i >= 0; i--) {
                        const chunk = data.chunks[i];
                        if (chunk.contentType === 'null' && chunk.annotations?.['config.type'] === 'runtime') {
                            backend = chunk.annotations['config.backend'];
                            model = chunk.annotations['config.model'];
                            break;
                        }
                    }
                }
                this.chat.backend = backend;
                this.chat.model = model;
                
                this.chat.uiMode = data.uiMode || 'chat';
                this.chat.showUIMode(this.chat.uiMode);
                
                this.chat.updateHeaderInfo();

                this.chat.messagesEl.innerHTML = '';
                this.chat.chunkElements.clear();
                this.chat.rawChunks = [];
                
                if (data.chunks && data.chunks.length > 0) {
                    console.log(`[RXCAFE] Rendering ${data.chunks.length} history chunks`);
                    let messageCount = 0;
                    for (const chunk of data.chunks) {
                        this.chat.addRawChunk(chunk);
                        this.chat.renderChunk(chunk);
                        if (chunk.annotations?.['chat.role'] === 'user' || chunk.annotations?.['chat.role'] === 'assistant') {
                            messageCount++;
                        }
                    }
                    // Update message count for this session
                    const session = this.chat.knownSessions.find(s => s.id === sessionId);
                    if (session) {
                        const oldCount = session.messageCount || 0;
                        session.messageCount = messageCount;
                        session.newMessageCount = 0; // Clear new messages since we're viewing it
                    }
                }
                
                await this.chat.updateUIState();
                this.chat.updateInspector();
                this.chat.renderSidebarSessionList();

                this.chat.connectStream(sessionId);
                
                // Hide quickies view, show messages
                if (window.quickiesManager) {
                    window.quickiesManager.onSessionChange(sessionId);
                }
            }
        } catch (error) {
            console.error('[RXCAFE] Failed to switch session:', error);
            this.chat.showError('Failed to switch session');
        }
    }

    async createSession(agentId, config) {
        const { backend, model, systemPrompt, llmParams, ...restConfig } = config;
        
        try {
            const response = await fetch(this.chat.apiUrl('/api/session'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    backend: backend,
                    model: model,
                    agentId: agentId,
                    llmParams: llmParams,
                    systemPrompt: systemPrompt,
                    ...restConfig
                })
            });
            
            const data = await response.json();
            
            if (data.sessionId) {
                const existingIndex = this.chat.knownSessions.findIndex(s => s.id === data.sessionId);
                if (existingIndex === -1) {
                    this.chat.knownSessions.push({
                        id: data.sessionId,
                        agentName: data.agentName,
                        isBackground: data.isBackground,
                        messageCount: 0,
                        newMessageCount: 0
                    });
                }
                
                await this.chat.switchToSession(data.sessionId);
                
                this.chat.addSystemMessage(`Session created: ${this.chat.agentName}`);
                if (backend) {
                    this.chat.addSystemMessage(`Backend: ${backend}${model ? ' (' + model + ')' : ''}`);
                }
                this.chat.addSystemMessage('Commands: /web URL | /system prompt | /addchunk JSON');
                
                this.chat.messageInput.focus();
            }
        } catch (error) {
            console.error('Failed to create session:', error);
            this.chat.showError('Failed to create session. Is the server running?');
        }
    }

    async renameSession(sessionId) {
        const session = this.chat.knownSessions.find(s => s.id === sessionId);
        const currentName = session ? (session.displayName || session.agentName) : '';
        const newName = prompt('Enter new session name:', currentName);
        
        if (newName === null || newName === currentName) return;

        try {
            const response = await fetch(this.chat.apiUrl(`/api/session/${sessionId}/chunk`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contentType: 'null',
                    producer: 'com.rxcafe.user-ui',
                    annotations: {
                        'session.name': newName
                    },
                    emit: true
                })
            });
            const data = await response.json();

            if (data.success) {
                if (session) {
                    session.displayName = newName;
                    if (this.chat.sessionsSidebar.style.display === 'flex') {
                        this.chat.renderSidebarSessionList();
                    }
                    this.chat.renderSessionList();
                }
            } else {
                this.chat.showError(data.message || 'Failed to rename session');
            }
        } catch (error) {
            console.error('Failed to rename session:', error);
            this.chat.showError('Error renaming session');
        }
    }

    async deleteSession(sessionId) {
        if (!confirm('Are you sure you want to delete this session? History will be lost.')) return;
        console.log(`[RXCAFE] Deleting session: ${sessionId}`);

        try {
            const response = await fetch(this.chat.apiUrl(`/api/session/${sessionId}`), {
                method: 'DELETE'
            });
            const data = await response.json();
            console.log(`[RXCAFE] Delete response:`, data);

            if (data.success) {
                if (this.chat.sessionId === sessionId) {
                    console.log('[RXCAFE] Deleted current session, clearing UI');
                    this.chat.sessionId = null;
                    if (window.location.hash.substring(1) === sessionId) {
                        history.replaceState(null, null, ' ');
                    }
                    this.chat.messagesEl.innerHTML = '<div class="welcome-message"><h2>Session Deleted</h2><p>Please create or select another session.</p></div>';
                    this.chat.backendInfoEl.textContent = 'No session';
                    this.chat.messageInput.disabled = true;
                    this.chat.sendBtn.disabled = true;
                    this.chat.disconnectStream();
                }
                await this.loadSessions();
                
                if (this.chat.sessionsSidebar.style.display === 'flex') {
                    this.chat.renderSidebarSessionList();
                }

                console.log('[RXCAFE] Session list updated after delete');
                
                // Show quickies view if no session
                if (window.quickiesManager) {
                    window.quickiesManager.onSessionChange(this.chat.sessionId);
                }
            } else {
                this.chat.showError(data.message || 'Failed to delete session');
            }
        } catch (error) {
            console.error('Failed to delete session:', error);
            this.chat.showError('Error deleting session');
        }
    }

    connectToSessionUpdates() {
        if (this.sessionUpdatesEventSource) {
            this.sessionUpdatesEventSource.close();
        }

        const url = this.chat.apiUrl('/api/sessions/updates');
        this.sessionUpdatesEventSource = new EventSource(url);

        this.sessionUpdatesEventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'session-update') {
                    this.handleSessionUpdate(data.sessionId, data.messageCount);
                }
            } catch (error) {
                console.error('[Sessions] Failed to parse session update:', error);
            }
        };

        this.sessionUpdatesEventSource.onerror = (error) => {
            console.error('[Sessions] Session updates stream error:', error);
            // Reconnect after a delay
            setTimeout(() => this.connectToSessionUpdates(), 5000);
        };

        this.sessionUpdatesEventSource.onopen = () => {
            console.log('[Sessions] Connected to session updates stream');
        };
    }

    handleSessionUpdate(sessionId, messageCount) {
        const session = this.chat.knownSessions.find(s => s.id === sessionId);
        if (session) {
            const oldCount = session.messageCount || 0;
            session.messageCount = messageCount;

            // If this is not the current session, mark as having new messages
            if (sessionId !== this.chat.sessionId) {
                if (messageCount > oldCount) {
                    session.newMessageCount += (messageCount - oldCount);
                }
            } else {
                // For current session, clear new messages
                session.newMessageCount = 0;
            }

            this.chat.renderSidebarSessionList();
        } else {
            // Session not in knownSessions, reload the list
            this.loadSessions();
        }
    }

    disconnect() {
        if (this.sessionUpdatesEventSource) {
            this.sessionUpdatesEventSource.close();
            this.sessionUpdatesEventSource = null;
        }
    }

    async loadAgents() {
        try {
            const response = await fetch(this.chat.apiUrl('/api/agents'));
            const data = await response.json();

            if (data.agents && data.agents.length > 0) {
                this.chat.agents = data.agents;

                if (this.chat.agentSelect) {
                    this.chat.agentSelect.innerHTML = data.agents
                        .map(a => `<option value="${a.name}">${a.name}${a.startInBackground ? ' (background)' : ''}</option>`)
                        .join('');

                    const defaultAgent = data.agents.find(a => a.name === 'default') || data.agents[0];
                    if (defaultAgent) {
                        this.chat.agentSelect.value = defaultAgent.name;
                        this.chat.agentDescription.textContent = defaultAgent.description || '';
                    }
                }
            }
        } catch (error) {
            console.error('Failed to load agents:', error);
            if (this.chat.agentSelect) {
                this.chat.agentSelect.innerHTML = '<option value="default">default</option>';
            }
        }
    }
}
