import { ThemeManager } from './js/theme.js';
import { getToken, apiUrl } from './js/api.js';
import { autoResize, hideContextMenuOnClick } from './js/dom-utils.js';
import { StreamingManager } from './js/streaming.js';
import { RecordingManager } from './js/recording.js';
import { MessagesManager } from './js/messages.js';
import { SessionsManager } from './js/sessions.js';
import { UIManager } from './js/ui.js';
import { DiceUIAdapter } from './js/dice-ui.js';
import { ChessUIAdapter } from './js/chess-ui.js';
import { PipelineConfigAdapter } from './js/pipeline-config-adapter.js';

class RXCafeChat {
    constructor() {
        this.sessionId = null;
        this.backend = null;
        this.model = null;
        this.agentName = null;
        this.isBackground = false;
        this.isGenerating = false;
        this.isRecording = false;
        this.currentMessageEl = null;
        this.currentContent = '';
        this.chunkElements = new Map();
        this.rawChunks = [];
        this._elCounter = 0;
        this.contextMenuChunkId = null;
        this.token = getToken();
        this.inspectorVisible = false;
        this.agents = [];
        this.knownSessions = [];
        this.uiMode = 'chat';
        this.customUIAdapter = null;
        this.pipelineConfigAdapter = null;
        
        this._pendingUserMsg = null;
        this._lastAssistantEl = null;
        
        this.themeManager = new ThemeManager();
        this.streamingManager = new StreamingManager(this);
        this.recordingManager = new RecordingManager(this);
        this.messagesManager = new MessagesManager(this);
        this.sessionsManager = new SessionsManager(this);
        this.uiManager = new UIManager(this);
        
        this.pipelineConfigAdapter = new PipelineConfigAdapter(this);
        
        window.addEventListener('error', (e) => {
            alert(`JavaScript Error: ${e.message}\nFile: ${e.filename}\nLine: ${e.lineno}`);
        });
        
        window.addEventListener('unhandledrejection', (e) => {
            alert(`Unhandled Promise Error: ${e.reason}`);
        });
        
        this.init();
    }
    
    apiUrl(path) {
        return apiUrl(path, this.token);
    }
    
    init() {
        this.uiManager.cacheElements();
        this.themeManager.bindElements();
        this.uiManager.bindEvents();
        autoResize(this.messageInput);
        hideContextMenuOnClick(this.contextMenu);
        this.sessionsManager.loadSessions();
        
        this.uiModeToggleBtn = document.getElementById('ui-mode-toggle-btn');
        this.uiModeIcon = document.getElementById('ui-mode-icon');
        
        if (this.uiModeToggleBtn) {
            this.uiModeToggleBtn.addEventListener('click', () => this.toggleUIMode());
        }

        window.addEventListener('hashchange', () => this.handleHashChange());
        
        // Initialize quickies manager
        if (window.quickiesManager) {
            window.quickiesManager.init();
        }
    }
    
    toggleUIMode() {
        const currentAgent = this.agents?.find(a => a.name === this.agentName);
        const supportedUIs = currentAgent?.supportedUIs || ['chat'];

        // Only toggle if agent supports multiple UIs
        if (supportedUIs.length <= 1) return;

        const currentIndex = supportedUIs.indexOf(this.uiMode);
        const nextIndex = (currentIndex + 1) % supportedUIs.length;
        const nextMode = supportedUIs[nextIndex];

        this.switchUIMode(nextMode);
    }
    
    async updateUIModeButton() {
        if (!this.uiModeToggleBtn || !this.sessionId) {
            if (this.uiModeToggleBtn) this.uiModeToggleBtn.style.display = 'none';
            return;
        }

        // Load agents if not already loaded
        if (!this.agents || this.agents.length === 0) {
            await this.loadAgents();
        }

        const currentAgent = this.agents?.find(a => a.name === this.agentName);
        const supportedUIs = currentAgent?.supportedUIs || ['chat'];

        // Only show toggle for agents with multiple UI modes
        if (supportedUIs.length <= 1) {
            this.uiModeToggleBtn.style.display = 'none';
            return;
        }

        this.uiModeToggleBtn.style.display = 'flex';

        // Set icon based on current mode and available modes
        const currentIndex = supportedUIs.indexOf(this.uiMode);
        const nextIndex = (currentIndex + 1) % supportedUIs.length;
        const nextMode = supportedUIs[nextIndex];

        // Icon mapping for common UI modes
        const iconMap = {
            'chat': '💬',
            'game-dice': '🎲',
            'game-quiz': '🎯',
            'pipeline-config': '⚡',
            'voice': '🎤',
            'image': '🖼️'
        };

        this.uiModeIcon.textContent = iconMap[nextMode] || '🔄';
        this.uiModeToggleBtn.title = `Switch to ${nextMode}`;
    }

    async handleHashChange() {
        const hashId = window.location.hash.substring(1);
        if (hashId && hashId !== this.sessionId) {
            console.log(`[RXCAFE] Hash changed to ${hashId}, switching...`);
            await this.sessionsManager.switchToSession(hashId);
        } else if (!hashId && this.sessionId) {
            // Hash cleared - go back to quickies
            console.log('[RXCAFE] Hash cleared, showing quickies');
            this.sessionId = null;
            if (window.quickiesManager) {
                window.quickiesManager.onSessionChange(null);
            }
            this.disconnectStream();
            await this.updateUIState();
        }
    }

    async loadOllamaModels(backend) {
        if (!backend) return;
        
        this.ollamaModelSelect.innerHTML = '<option value="">Loading models...</option>';
        this.ollamaModelSelect.disabled = true;
        
        try {
            const response = await fetch(this.apiUrl(`/api/models?backend=${backend}`));
            const data = await response.json();
            
            if (data.models && data.models.length > 0) {
                this.ollamaModelSelect.innerHTML = data.models
                    .map(m => `<option value="${m}">${m}</option>`)
                    .join('');
                this.ollamaModelSelect.disabled = false;
            } else {
                this.ollamaModelSelect.innerHTML = '<option value="gemma3:1b">gemma3:1b</option>';
                this.ollamaModelSelect.disabled = false;
            }
        } catch (error) {
            console.error('Failed to load models:', error);
            this.ollamaModelSelect.innerHTML = '<option value="gemma3:1b">gemma3:1b (default)</option>';
            this.ollamaModelSelect.disabled = false;
        }
    }
    
    async showBackendModal() {
        if (this.wizardModal) {
            this.uiManager.showWizardModal();
            return;
        }
        this.backendModal.style.display = 'flex';
        await Promise.all([this.sessionsManager.loadAgents(), this.sessionsManager.loadSessions()]);
        
        const selectedBackend = document.querySelector('input[name="backend"]:checked')?.value;
        if (selectedBackend === 'ollama' || selectedBackend === 'openai') {
            this.loadOllamaModels(selectedBackend);
        }
    }
    
    async showWizardModal() {
        await this.uiManager.showWizardModal();
    }
    
    hideWizardModal() {
        this.uiManager.hideWizardModal();
    }
    
    hideBackendModal() {
        if (this.wizardModal) {
            this.wizardModal.style.display = 'none';
        } else if (this.backendModal) {
            this.backendModal.style.display = 'none';
        }
    }
    
    async createSession() {
        const selectedBackend = document.querySelector('input[name="backend"]:checked')?.value || 'kobold';
        const selectedModel = selectedBackend === 'ollama' ? this.ollamaModelSelect.value : undefined;
        const selectedAgent = this.agentSelect.value || 'default';
        
        const temperature = this.temperatureInput.value ? parseFloat(this.temperatureInput.value) : undefined;
        const maxTokens = this.maxTokensInput.value ? parseInt(this.maxTokensInput.value) : undefined;
        const systemPrompt = this.systemPromptInput.value.trim() || undefined;
        
        const llmParams = (temperature || maxTokens) ? {} : undefined;
        if (temperature !== undefined) llmParams.temperature = temperature;
        if (maxTokens !== undefined) llmParams.maxTokens = maxTokens;
        
        await this.sessionsManager.createSession(selectedAgent, {
            backend: selectedBackend,
            model: selectedModel,
            llmParams,
            systemPrompt
        });
        
        this.hideBackendModal();
    }
    
    async sendMessage() {
        if (!this.sessionId) {
            this.showWizardModal();
            return;
        }
        
        const message = this.messageInput.value.trim();
        if (!message || this.isGenerating) return;
        
        if (message.startsWith('/web ')) {
            const url = message.slice(5).trim();
            await this.handleWebCommand(url);
            this.messageInput.value = '';
            this.messageInput.style.height = 'auto';
            this.messageInput.focus();
            return;
        }
        
        if (message.startsWith('/system ')) {
            const prompt = message.slice(8).trim();
            await this.handleSystemCommand(prompt);
            this.messageInput.value = '';
            this.messageInput.style.height = 'auto';
            this.messageInput.focus();
            return;
        }
        
        if (message.startsWith('/addchunk ')) {
            const args = message.slice(10).trim();
            await this.handleAddChunkCommand(args);
            this.messageInput.value = '';
            this.messageInput.style.height = 'auto';
            this.messageInput.focus();
            return;
        }
        
        this._pendingUserMsg = this.messagesManager.addMessage('user', message);
        this._pendingUserMsg.dataset.pendingUser = 'true';
        this.messagesEl.appendChild(this._pendingUserMsg);
        this.scrollToBottom();
        this.messageInput.value = '';
        this.messageInput.style.height = 'auto';
        this.messageInput.focus();
        
        this.isGenerating = true;
        this._streamingEl = null;
        await this.updateUIState();

        try {
            const response = await fetch(this.apiUrl(`/api/chat/${this.sessionId}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message })
            });
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            this.streamingManager.handleStreamData(data);
                        } catch (e) {
                            console.error('Failed to parse SSE data:', e);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Streaming error:', error);
            if (this.currentMessageEl) {
                this.showErrorInMessage(this.currentMessageEl, 'Failed to get response. Check if the LLM server is running.');
            }
        } finally {
            this.isGenerating = false;
            if (this.currentMessageEl) {
                this.currentMessageEl.classList.remove('streaming');
            }
            this.currentMessageEl = null;
            this._streamingEl = null;
            this.currentContent = '';
            await this.updateUIState();
            this.messageInput.focus();
        }
    }

    async toggleRecording() {
        this.recordingManager.toggle();
    }
    
    async handleWebCommand(url) {
        if (!url) {
            this.showError('Please provide a URL: /web https://example.com');
            return;
        }
        
        const loadingEl = document.createElement('div');
        loadingEl.className = 'message system fetching';
        loadingEl.innerHTML = '<div class="message-content">Fetching web content...</div>';
        this.messagesEl.appendChild(loadingEl);
        this.scrollToBottom();
        
        try {
            const response = await fetch(this.apiUrl(`/api/session/${this.sessionId}/web`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url })
            });
            
            const data = await response.json();
            
            loadingEl.remove();
            
            if (data.success && data.chunk) {
                this.addSystemMessage(`Fetched: ${data.chunk.annotations?.['web.source-url'] || url}`);
            } else {
                this.showError(data.error || 'Failed to fetch web content');
            }
        } catch (error) {
            loadingEl.remove();
            console.error('Failed to fetch web content:', error);
            this.showError('Failed to fetch web content. Is the server running?');
        }
    }
    
    async handleSystemCommand(prompt) {
        if (!prompt) {
            this.showError('Please provide a prompt: /system You are a helpful assistant');
            return;
        }
        
        try {
            const response = await fetch(this.apiUrl(`/api/session/${this.sessionId}/chunk`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: prompt,
                    producer: 'com.rxcafe.system-prompt',
                    annotations: {
                        'chat.role': 'system',
                        'system.prompt': true
                    }
                })
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.messagesManager.addSystemChunk(data.chunk, prompt);
            } else {
                this.showError(data.error || 'Failed to set system prompt');
            }
        } catch (error) {
            console.error('Failed to set system prompt:', error);
            this.showError('Failed to set system prompt. Is the server running?');
        }
    }
    
    async handleAddChunkCommand(args) {
        try {
            const parsed = JSON.parse(args);
            
            if (parsed.content === undefined && parsed.contentType !== 'null') {
                this.showError('Chunk must have content field or contentType: "null"');
                return;
            }
            
            const body = {
                producer: parsed.producer || 'com.rxcafe.user',
                annotations: parsed.annotations || {}
            };
            
            if (parsed.contentType === 'null') {
                body.contentType = 'null';
            } else {
                body.content = parsed.content;
            }
            
            const response = await fetch(this.apiUrl(`/api/session/${this.sessionId}/chunk`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.addRawChunk(data.chunk);
                this.addSystemMessage(`Chunk added: ${data.chunk.id}`);
            } else {
                this.showError(data.error || 'Failed to add chunk');
            }
        } catch (error) {
            this.showError('Usage: /addchunk {"content":"...", "annotations":{...}}');
        }
    }
    
    createMessageElement(role, content, annotations = {}) {
        const textEl = document.createElement('rx-message-text');
        this._elCounter++;
        textEl.dataset.elId = this._elCounter;
        textEl.role = role;
        textEl.content = content;
        textEl.annotations = annotations;
        return textEl;
    }

    updateMessageContent(messageEl, content, annotations = {}) {
        if (messageEl.tagName === 'RX-MESSAGE-TEXT') {
            messageEl.content = content;
            if (annotations && Object.keys(annotations).length > 0) {
                messageEl.annotations = { ...messageEl.annotations, ...annotations };
            }
        }
        this.scrollToBottom();
    }
    
    addMessage(role, content, chunkId = null, annotations = {}) {
        return this.messagesManager.addMessage(role, content, chunkId, annotations);
    }
    
    updateSentiment(messageEl, sentiment) {
        this.messagesManager.updateSentiment(messageEl, sentiment);
    }
    
    addSystemMessage(text) {
        const messageEl = document.createElement('div');
        messageEl.className = 'system-message';
        messageEl.style.cssText = 'text-align: center; color: #6b7280; font-size: 0.875rem; margin: 1rem 0;';
        messageEl.textContent = text;
        this.messagesEl.appendChild(messageEl);
        this.scrollToBottom();
    }
    
    showError(message) {
        const errorEl = document.createElement('div');
        errorEl.className = 'error-message';
        errorEl.textContent = message;
        this.messagesEl.appendChild(errorEl);
        this.scrollToBottom();
    }
    
    showErrorInMessage(messageEl, error) {
        if (messageEl.tagName === 'RX-MESSAGE-TEXT') {
            messageEl.content = `Error: ${error}`;
        }
    }
    
    renderErrorChunk(errorMessage) {
        this.messagesManager.addErrorMessage({
            id: crypto.randomUUID(),
            contentType: 'null',
            content: null,
            producer: 'com.rxcafe.error',
            annotations: { 'error.message': errorMessage },
            timestamp: Date.now()
        });
    }
    
    async updateUIState() {
        this.uiManager.updateUIState();
        await this.updateUIModeButton();
    }
    
    connectStream(sessionId) {
        this.streamingManager.connect(sessionId);
    }
    
    disconnectStream() {
        this.streamingManager.disconnect();
    }
    
    renderChunk(chunk) {
        this.messagesManager.renderChunk(chunk);
    }
    
    addRawChunk(chunk) {
        if (chunk.annotations?.['session.name']) {
            const newName = chunk.annotations['session.name'];
            const session = this.knownSessions.find(s => s.id === this.sessionId);
            if (session) {
                session.displayName = newName;
                if (this.sessionsSidebar.style.display === 'flex') {
                    this.renderSidebarSessionList();
                }
            }
        }

        const existingIndex = this.rawChunks.findIndex(c => c.id === chunk.id);
        if (existingIndex !== -1) {
            this.rawChunks[existingIndex] = chunk;
        } else {
            this.rawChunks.push(chunk);
        }
        console.log(`[RXCAFE] addRawChunk id=${chunk.id} total=${this.rawChunks.length}`);
        if (this.inspectorVisible) {
            this.updateInspector();
        }
    }
    
    updateInspector() {
        this.uiManager.updateInspector();
    }
    
    scrollToBottom() {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
    
    async toggleTrust(trusted) {
        if (!this.contextMenuChunkId || !this.sessionId) return;
        
        try {
            const response = await fetch(this.apiUrl(`/api/session/${this.sessionId}/chunk/${this.contextMenuChunkId}/trust`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trusted })
            });
            
            const data = await response.json();
            
            if (data.success) {
                const chunkEl = this.chunkElements.get(this.contextMenuChunkId);
                if (chunkEl) {
                    chunkEl.classList.remove('trusted', 'untrusted');
                    chunkEl.classList.add(trusted ? 'trusted' : 'untrusted');
                    
                    if (chunkEl.tagName === 'RX-MESSAGE-WEB') {
                        chunkEl.trusted = trusted;
                    }
                    
                    const badge = chunkEl.querySelector('.trust-badge');
                    if (badge) {
                        badge.textContent = trusted ? 'Trusted' : 'Untrusted';
                        badge.className = `trust-badge ${trusted ? 'trusted' : 'untrusted'}`;
                    }
                }
                
                const rawChunk = this.rawChunks.find(c => c.id === this.contextMenuChunkId);
                if (rawChunk) {
                    rawChunk.annotations = rawChunk.annotations || {};
                    rawChunk.annotations['security.trust-level'] = {
                        trusted: trusted,
                        source: rawChunk.annotations['security.trust-level']?.source || 'manual',
                        requiresReview: !trusted
                    };
                    if (this.inspectorVisible) {
                        this.updateInspector();
                    }
                }
            }
        } catch (error) {
            console.error('Failed to toggle trust:', error);
            this.showError('Failed to update trust status');
        }
        
        this.uiManager.hideContextMenu();
    }
    
    async toggleTrustFromButton(chunkId, trusted) {
        if (!this.sessionId) return;
        
        try {
            const response = await fetch(this.apiUrl(`/api/session/${this.sessionId}/chunk/${chunkId}/trust`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trusted })
            });
            
            const data = await response.json();
            
            if (data.success) {
                const chunkEl = this.chunkElements.get(chunkId);
                if (chunkEl) {
                    chunkEl.classList.remove('trusted', 'untrusted');
                    chunkEl.classList.add(trusted ? 'trusted' : 'untrusted');
                    
                    if (chunkEl.tagName === 'RX-MESSAGE-WEB') {
                        chunkEl.trusted = trusted;
                    }
                    
                    const badge = chunkEl.querySelector('.trust-badge');
                    if (badge) {
                        badge.textContent = trusted ? 'Trusted' : 'Untrusted';
                        badge.className = `trust-badge ${trusted ? 'trusted' : 'untrusted'}`;
                    }
                    
                    const toggle = chunkEl.querySelector('.trust-toggle');
                    if (toggle) {
                        toggle.textContent = trusted ? 'Untrust' : 'Trust';
                        toggle.onclick = () => this.toggleTrustFromButton(chunkId, !trusted);
                    }
                }
                
                const rawChunk = this.rawChunks.find(c => c.id === chunkId);
                if (rawChunk) {
                    rawChunk.annotations = rawChunk.annotations || {};
                    rawChunk.annotations['security.trust-level'] = {
                        trusted: trusted,
                        source: rawChunk.annotations['security.trust-level']?.source || 'manual',
                        requiresReview: !trusted
                    };
                    if (this.inspectorVisible) {
                        this.updateInspector();
                    }
                }
            }
        } catch (error) {
            console.error('Failed to toggle trust:', error);
            this.showError('Failed to update trust status');
        }
    }
    
    copyChunkContent() {
        if (!this.contextMenuChunkId) return;
        
        const chunkEl = this.chunkElements.get(this.contextMenuChunkId);
        if (chunkEl) {
            const content = chunkEl.querySelector('.message-content')?.textContent || '';
            navigator.clipboard.writeText(content).then(() => {
                this.uiManager.hideContextMenu();
            });
        }
    }
    
    async deleteChunkFromInspector(chunkId, event) {
        if (!this.sessionId) return;
        
        const shiftKey = event?.shiftKey;
        const chunkIndex = this.rawChunks.findIndex(c => c.id === chunkId);
        if (chunkIndex === -1) return;
        
        const chunksToDelete = shiftKey 
            ? this.rawChunks.slice(chunkIndex)
            : this.rawChunks.filter(c => c.id === chunkId);
        
        const message = shiftKey
            ? `Delete this chunk and all ${chunksToDelete.length - 1} after it? This cannot be undone.`
            : 'Delete this chunk? This cannot be undone.';
        
        if (!confirm(message)) return;
        
        try {
            const idsToDelete = shiftKey
                ? this.rawChunks.slice(chunkIndex).map(c => c.id)
                : [chunkId];
            
            for (const id of idsToDelete) {
                await fetch(this.apiUrl(`/api/session/${this.sessionId}/chunk/${id}`), {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            
            this.rawChunks = this.rawChunks.filter(c => !idsToDelete.includes(c.id));
            
            for (const id of idsToDelete) {
                const chunkEl = this.chunkElements.get(id);
                if (chunkEl) {
                    chunkEl.remove();
                    this.chunkElements.delete(id);
                }
            }
            
            if (this.inspectorVisible) {
                this.updateInspector();
            }
        } catch (error) {
            console.error('Failed to delete chunk:', error);
            this.showError('Failed to delete chunk');
        }
    }
    
    showContextMenu(e, chunkId) {
        this.contextMenuChunkId = chunkId;
        this.uiManager.showContextMenu(e, chunkId);
    }
    
    async abortGeneration() {
        if (!this.sessionId || !this.isGenerating) return;
        
        try {
            await fetch(this.apiUrl(`/api/chat/${this.sessionId}/abort`), {
                method: 'POST'
            });
        } catch (error) {
            console.error('Failed to abort:', error);
        }
    }
    
    updateHeaderInfo() {
        this.uiManager.updateHeaderInfo();
    }
    
    renderSidebarSessionList() {
        this.uiManager.renderSidebarSessionList();
    }
    
    renderSessionList() {
        this.uiManager.renderSessionList();
    }
    
    showSessionsModal() {
        this.uiManager.showSessionsModal();
    }
    
    hideSessionsModal() {
        this.uiManager.hideSessionsModal();
    }
    
    toggleSessionsSidebar() {
        this.uiManager.toggleSessionsSidebar();
    }
    
    showSessionsSidebar() {
        this.uiManager.showSessionsSidebar();
    }
    
    hideSessionsSidebar() {
        this.uiManager.hideSessionsSidebar();
    }
    
    showSidebarMenu(e, sessionId) {
        this.uiManager.showSidebarMenu(e, sessionId);
    }
    
    hideSidebarMenu() {
        this.uiManager.hideSidebarMenu();
    }
    
    async switchToSessionFromSidebar(sessionId) {
        if (sessionId === this.sessionId) return;
        await this.sessionsManager.switchToSession(sessionId);
        if (window.innerWidth <= 800) {
            this.hideSessionsSidebar();
        }
    }
    
    async switchToSessionFromModal(sessionId) {
        await this.sessionsManager.switchToSession(sessionId);
        this.hideSessionsModal();
    }
    
    async renameSessionFromMenu() {
        const sessionId = this.sidebarMenuSessionId;
        this.hideSidebarMenu();
        if (sessionId) {
            await this.sessionsManager.renameSession(sessionId);
        }
    }
    
    async deleteSessionFromMenu() {
        const sessionId = this.sidebarMenuSessionId;
        this.hideSidebarMenu();
        if (sessionId) {
            await this.sessionsManager.deleteSession(sessionId);
        }
    }
    
    async renameSession(sessionId) {
        await this.sessionsManager.renameSession(sessionId);
    }
    
    async deleteSession(sessionId) {
        await this.sessionsManager.deleteSession(sessionId);
    }
    
    async loadSessions() {
        await this.sessionsManager.loadSessions();
    }
    
    async loadAgents() {
        await this.sessionsManager.loadAgents();
        await this.updateUIModeButton();
    }
    
    async switchToSession(sessionId) {
        await this.sessionsManager.switchToSession(sessionId);
    }
    
    async createSessionFromWizard(agentId, config) {
        await this.sessionsManager.createSession(agentId, config);
    }
    
    async handleWizardComplete(e) {
        this.uiManager.handleWizardComplete(e);
    }
    
    toggleInspector() {
        this.uiManager.toggleInspector();
    }
    
    showInspector() {
        this.uiManager.showInspector();
    }
    
    hideInspector() {
        this.uiManager.hideInspector();
    }
    
    async switchUIMode(mode) {
        if (!this.sessionId) return;
        if (mode === this.uiMode) return;
        
        this.uiMode = mode;
        
        try {
            await fetch(this.apiUrl(`/api/session/${this.sessionId}/ui-mode`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uiMode: mode })
            });
        } catch (err) {
            console.error('Failed to save UI mode:', err);
        }
        
        await this.showUIMode(mode);
    }

    async showUIMode(mode) {
        const customView = document.getElementById('dice-view'); // Reused for custom UIs
        const messagesView = document.getElementById('messages');
        const inputContainer = document.querySelector('.input-container');
        const quickiesView = document.getElementById('quickies-view');

        // Hide all views first
        if (quickiesView) quickiesView.style.display = 'none';
        if (messagesView) messagesView.style.display = 'none';

        if (mode === 'chat') {
            // Standard chat mode
            if (customView) customView.style.display = 'none';
            if (messagesView) messagesView.style.display = 'flex';
            if (inputContainer) inputContainer.style.display = 'flex';

            // Clean up custom UI adapter
            if (this.customUIAdapter) {
                this.customUIAdapter.destroy();
                this.customUIAdapter = null;
            }
        } else {
            // Custom UI mode (game-dice, etc.)
            if (messagesView) messagesView.style.display = 'none';
            if (inputContainer) inputContainer.style.display = 'none';
            if (customView) customView.style.display = 'flex';

            // Clean up previous adapter
            if (this.customUIAdapter) {
                this.customUIAdapter.destroy();
                this.customUIAdapter = null;
            }

            // Create appropriate adapter based on mode
            if (mode === 'game-dice') {
                this.customUIAdapter = new DiceUIAdapter(this);
                this.customUIAdapter.init(this.sessionId);
            } else if (mode === 'game-quiz') {
                this.customUIAdapter = new QuizUIAdapter(this);
                this.customUIAdapter.init(this.sessionId);
            } else if (mode === 'game-chess') {
                this.customUIAdapter = new ChessUIAdapter(this);
                this.customUIAdapter.init(this.sessionId);
            } else if (mode === 'pipeline-config') {
                this.pipelineConfigAdapter.init(this.sessionId);
                this.pipelineConfigAdapter.show();
            }
            // Future custom UI modes can be added here
        }

        await this.updateUIModeButton();
    }
}

let chat;

document.addEventListener('DOMContentLoaded', () => {
    chat = new RXCafeChat();
    window.chat = chat;
});
