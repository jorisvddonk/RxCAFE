/**
 * RXCAFE Chat Frontend
 * Simple chat interface for the RXCAFE API
 * Supports both KoboldCPP and Ollama backends
 * Includes web fetch with trust system
 */

// Theme Manager
class ThemeManager {
    constructor() {
        this.themeToggleBtn = null;
        this.currentTheme = localStorage.getItem('theme') || 'dark';
        this.init();
    }

    init() {
        this.applyTheme(this.currentTheme);
    }

    bindElements() {
        this.themeToggleBtn = document.getElementById('theme-toggle-btn');
        if (this.themeToggleBtn) {
            this.themeToggleBtn.addEventListener('click', () => this.toggleTheme());
            this.updateToggleIcon();
        }
    }

    applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
        this.currentTheme = theme;
        this.updateToggleIcon();
    }

    toggleTheme() {
        const newTheme = this.currentTheme === 'light' ? 'dark' : 'light';
        this.applyTheme(newTheme);
    }

    updateToggleIcon() {
        if (this.themeToggleBtn) {
            this.themeToggleBtn.textContent = this.currentTheme === 'light' ? '🌙' : '☀️';
            this.themeToggleBtn.title = this.currentTheme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
        }
    }
}

// Global theme manager instance
const themeManager = new ThemeManager();

class RXCafeChat {
    constructor() {
        this.sessionId = null;
        this.backend = null;
        this.model = null;
        this.agentName = null;
        this.isBackground = false;
        this.isGenerating = false;
        this.currentMessageEl = null;
        this.currentContent = '';
        this.chunkElements = new Map();
        this.rawChunks = []; this._elCounter = 0;
        this.contextMenuChunkId = null;
        this.token = this.getToken();
        this.inspectorVisible = false;
        this.agents = [];
        this.knownSessions = [];
        this.eventSource = null;
        this._reconnectTimer = null;
        
        this.init();
    }
    
    // Get token from injected script or URL params
    getToken() {
        // First check for injected token from server
        if (window.RXCAFE_TOKEN) {
            return window.RXCAFE_TOKEN;
        }
        // Fallback to URL query param
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('token');
    }
    
    // Build API URL with token
    apiUrl(path) {
        const url = new URL(path, window.location.origin);
        if (this.token) {
            url.searchParams.set('token', this.token);
        }
        return url.toString();
    }
    
    init() {
        this.cacheElements();
        themeManager.bindElements();
        this.bindEvents();
        this.autoResize();
        this.hideContextMenuOnClick();
        this.loadSessionsOnStart();

        window.addEventListener('hashchange', () => this.handleHashChange());
    }

    handleHashChange() {
        const hashId = window.location.hash.substring(1);
        if (hashId && hashId !== this.sessionId) {
            console.log(`[RXCAFE] Hash changed to ${hashId}, switching...`);
            this.switchToSession(hashId);
        }
    }
    
    async loadSessionsOnStart() {
        await this.loadSessions();
    }
    
    cacheElements() {
        this.backendInfoEl = document.getElementById('backend-info');
        this.newSessionBtn = document.getElementById('new-session-btn');
        this.messagesEl = document.getElementById('messages');
        this.messageInput = document.getElementById('message-input');
        this.sendBtn = document.getElementById('send-btn');
        this.abortBtn = document.getElementById('abort-btn');
        this.copySessionIdBtn = document.getElementById('copy-session-id-btn');
        
        // Modal elements
        this.backendModal = document.getElementById('backend-modal');
        this.createSessionBtn = document.getElementById('create-session-btn');
        this.cancelBtn = document.getElementById('cancel-btn');
        this.backendRadios = document.querySelectorAll('input[name="backend"]');
        this.ollamaModelSection = document.getElementById('ollama-model-section');
        this.ollamaModelSelect = document.getElementById('ollama-model');
        
        // Agent elements
        this.agentSelect = document.getElementById('agent-select');
        this.agentDescription = document.getElementById('agent-description');
        
        // Advanced options
        this.temperatureInput = document.getElementById('temperature');
        this.maxTokensInput = document.getElementById('max-tokens');
        this.systemPromptInput = document.getElementById('system-prompt');
        
        // Context menu
        this.contextMenu = document.getElementById('context-menu');
        this.contextTrust = document.getElementById('context-trust');
        this.contextUntrust = document.getElementById('context-untrust');
        this.contextCopy = document.getElementById('context-copy');
        
        // Inspector elements
        this.inspectorPanel = document.getElementById('inspector-panel');
        this.inspectorOverlay = document.getElementById('inspector-overlay');
        this.inspectorToggleBtn = document.getElementById('inspector-toggle-btn');
        this.inspectorCloseBtn = document.getElementById('inspector-close-btn');
        this.inspectorSession = document.getElementById('inspector-session');
        this.inspectorChunkCount = document.getElementById('inspector-chunk-count');
        this.inspectorChunks = document.getElementById('inspector-chunks');

        // Sessions management elements
        this.sessionsModal = document.getElementById('sessions-modal');
        this.sessionList = document.getElementById('session-list');
        this.manageSessionsBtn = document.getElementById('manage-sessions-btn');
        this.sessionsCloseBtn = document.getElementById('sessions-close-btn');

        // Sessions sidebar elements
        this.sessionsSidebar = document.getElementById('sessions-sidebar');
        this.sessionsSidebarOverlay = document.getElementById('sessions-sidebar-overlay');
        this.sessionsSidebarToggleBtn = document.getElementById('sessions-sidebar-toggle-btn');
        this.sessionsSidebarCloseBtn = document.getElementById('sessions-sidebar-close-btn');
        this.sidebarSessionList = document.getElementById('sidebar-session-list');
        this.sidebarNewSessionBtn = document.getElementById('sidebar-new-session-btn');

        // Sidebar global actions (mobile)
        this.sidebarThemeToggleBtn = document.getElementById('sidebar-theme-toggle-btn');
        this.sidebarManageSessionsBtn = document.getElementById('sidebar-manage-sessions-btn');

        // Sidebar menu elements
        this.sidebarMenu = document.getElementById('sidebar-menu');
        this.sidebarMenuRename = document.getElementById('sidebar-menu-rename');
        this.sidebarMenuDelete = document.getElementById('sidebar-menu-delete');
        this.sidebarMenuSessionId = null;
    }

    bindEvents() {
        this.newSessionBtn.addEventListener('click', () => this.showBackendModal());
        this.createSessionBtn.addEventListener('click', () => this.createSession());
        this.cancelBtn.addEventListener('click', () => this.hideBackendModal());
        this.sendBtn.addEventListener('click', () => this.sendMessage());
        this.abortBtn.addEventListener('click', () => this.abortGeneration());
        this.copySessionIdBtn.addEventListener('click', () => this.copySessionId());
        
        this.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });
        
        // Backend radio change
        this.backendRadios.forEach(radio => {
            radio.addEventListener('change', () => {
                const isOllama = radio.value === 'ollama' && radio.checked;
                this.ollamaModelSection.style.display = isOllama ? 'block' : 'none';
                if (isOllama) {
                    this.loadOllamaModels('ollama');
                }
            });
        });
        
        // Agent select change
        this.agentSelect.addEventListener('change', () => {
            const selectedAgent = this.agents.find(a => a.name === this.agentSelect.value);
            if (selectedAgent) {
                this.agentDescription.textContent = selectedAgent.description || 'No description';
            } else {
                this.agentDescription.textContent = '';
            }
        });
        
        // Context menu actions
        this.contextTrust.addEventListener('click', () => this.toggleTrust(true));
        this.contextUntrust.addEventListener('click', () => this.toggleTrust(false));
        this.contextCopy.addEventListener('click', () => this.copyChunkContent());
        
        // Inspector events
        this.inspectorToggleBtn.addEventListener('click', () => this.toggleInspector());
        this.inspectorCloseBtn.addEventListener('click', () => this.hideInspector());
        if (this.inspectorOverlay) {
            this.inspectorOverlay.addEventListener('click', () => this.hideInspector());
        }

        // Sessions management events
        this.manageSessionsBtn.addEventListener('click', () => this.showSessionsModal());
        this.sessionsCloseBtn.addEventListener('click', () => this.hideSessionsModal());

        // Sessions sidebar events
        this.sessionsSidebarToggleBtn.addEventListener('click', () => this.toggleSessionsSidebar());
        this.sessionsSidebarCloseBtn.addEventListener('click', () => this.hideSessionsSidebar());
        if (this.sessionsSidebarOverlay) {
            this.sessionsSidebarOverlay.addEventListener('click', () => this.hideSessionsSidebar());
        }
        this.sidebarNewSessionBtn.addEventListener('click', () => {
            this.hideSessionsSidebar();
            this.showBackendModal();
        });

        if (this.sidebarThemeToggleBtn) {
            this.sidebarThemeToggleBtn.addEventListener('click', () => themeManager.toggleTheme());
        }
        if (this.sidebarManageSessionsBtn) {
            this.sidebarManageSessionsBtn.addEventListener('click', () => {
                this.hideSessionsSidebar();
                this.showSessionsModal();
            });
        }

        // Sidebar menu events
        this.sidebarMenuRename.addEventListener('click', () => this.renameSessionFromMenu());
        this.sidebarMenuDelete.addEventListener('click', () => this.deleteSessionFromMenu());
        
        // Close menus on click outside
        document.addEventListener('click', (e) => {
            if (this.sidebarMenu.style.display === 'block' && !e.target.closest('.sidebar-session-more-btn') && !this.sidebarMenu.contains(e.target)) {
                this.hideSidebarMenu();
            }
        });

        // Initial sidebar state based on screen width
        if (window.innerWidth > 800) {
            this.showSessionsSidebar();
        }
    }
    
    hideContextMenuOnClick() {
        document.addEventListener('click', (e) => {
            if (!this.contextMenu.contains(e.target)) {
                this.hideContextMenu();
            }
        });
    }
    
    showContextMenu(e, chunkId) {
        e.preventDefault();
        this.contextMenuChunkId = chunkId;
        
        // Get the chunk element to check trust status
        const chunkEl = this.chunkElements.get(chunkId);
        if (chunkEl) {
            const isTrusted = chunkEl.classList.contains('trusted');
            this.contextTrust.style.display = isTrusted ? 'none' : 'block';
            this.contextUntrust.style.display = isTrusted ? 'block' : 'none';
        }
        
        this.contextMenu.style.display = 'block';
        this.contextMenu.style.left = `${e.pageX}px`;
        this.contextMenu.style.top = `${e.pageY}px`;
    }
    
    hideContextMenu() {
        this.contextMenu.style.display = 'none';
        this.contextMenuChunkId = null;
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
                    
                    // Update trust badge
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
        
        this.hideContextMenu();
    }
    
    copyChunkContent() {
        if (!this.contextMenuChunkId) return;
        
        const chunkEl = this.chunkElements.get(this.contextMenuChunkId);
        if (chunkEl) {
            const content = chunkEl.querySelector('.message-content')?.textContent || '';
            navigator.clipboard.writeText(content).then(() => {
                this.hideContextMenu();
            });
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
    
    autoResize() {
        this.messageInput.addEventListener('input', () => {
            this.messageInput.style.height = 'auto';
            this.messageInput.style.height = Math.min(this.messageInput.scrollHeight, 200) + 'px';
        });
    }
    
    async showBackendModal() {
        this.backendModal.style.display = 'flex';
        
        // Load agents and sessions
        await Promise.all([this.loadAgents(), this.loadSessions()]);
        
        const selectedBackend = document.querySelector('input[name="backend"]:checked')?.value;
        if (selectedBackend === 'ollama') {
            this.loadOllamaModels('ollama');
        }
    }
    
    async loadAgents() {
        try {
            const response = await fetch(this.apiUrl('/api/agents'));
            const data = await response.json();
            
            if (data.agents && data.agents.length > 0) {
                this.agents = data.agents;
                this.agentSelect.innerHTML = data.agents
                    .map(a => `<option value="${a.name}">${a.name}${a.startInBackground ? ' (background)' : ''}</option>`)
                    .join('');
                
                // Select default agent and show description
                const defaultAgent = data.agents.find(a => a.name === 'default') || data.agents[0];
                if (defaultAgent) {
                    this.agentSelect.value = defaultAgent.name;
                    this.agentDescription.textContent = defaultAgent.description || '';
                }
            }
        } catch (error) {
            console.error('Failed to load agents:', error);
            this.agentSelect.innerHTML = '<option value="default">default</option>';
        }
    }
    
    async loadSessions() {
        console.log('[RXCAFE] loadSessions called');
        try {
            const response = await fetch(this.apiUrl('/api/sessions'));
            const data = await response.json();
            console.log('[RXCAFE] loadSessions data:', data);
            
            if (data.sessions) {
                this.knownSessions = data.sessions;
                
                // Render sidebar list automatically if sessions exist
                this.renderSidebarSessionList();

                if (this.sessionsModal.style.display === 'flex') {
                    console.log('[RXCAFE] Updating session list in modal');
                    this.renderSessionList();
                }
                
                // Auto-connect: check hash first, then most recent non-background
                if (!this.sessionId && data.sessions.length > 0) {
                    const hashId = window.location.hash.substring(1);
                    const sessionInHash = data.sessions.find(s => s.id === hashId);
                    
                    if (sessionInHash) {
                        console.log(`[RXCAFE] Auto-connecting to session from URL hash: ${hashId}`);
                        await this.switchToSession(hashId);
                    } else {
                        const recentSession = data.sessions.find(s => !s.isBackground) || data.sessions[0];
                        if (recentSession) {
                            await this.switchToSession(recentSession.id);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Failed to load sessions:', error);
        }
    }
    
    async switchToSession(sessionId) {
        console.log(`[RXCAFE] switchToSession: ${sessionId}`);
        this.disconnectStream();

        // Update URL hash
        if (window.location.hash.substring(1) !== sessionId) {
            window.location.hash = sessionId;
        }

        try {
            console.log(`[RXCAFE] Fetching history for ${sessionId}...`);
            const response = await fetch(this.apiUrl(`/api/session/${sessionId}/history`));
            const data = await response.json();
            console.log(`[RXCAFE] History response:`, data.sessionId, `chunks:`, data.chunks?.length ?? 0);
            
            if (data.sessionId) {
                this.sessionId = data.sessionId;
                this.backend = data.backend;
                this.model = data.model;
                
                const sessionInfo = this.knownSessions.find(s => s.id === sessionId);
                if (sessionInfo) {
                    this.agentName = sessionInfo.agentName;
                    this.isBackground = sessionInfo.isBackground;
                    if (data.displayName) sessionInfo.displayName = data.displayName;
                }
                
                const info = [];
                info.push(data.displayName || this.agentName || 'unknown');
                if (this.backend) info.push(this.backend);
                if (this.model) info.push(this.model);
                if (this.isBackground) info.push('[background]');
                this.backendInfoEl.textContent = info.join(' | ');
                
                this.messagesEl.innerHTML = '';
                this.chunkElements.clear();
                this.rawChunks = [];
                
                if (data.chunks && data.chunks.length > 0) {
                    console.log(`[RXCAFE] Rendering ${data.chunks.length} history chunks`);
                    for (const chunk of data.chunks) {
                        this.addRawChunk(chunk);
                        this.renderChunk(chunk);
                    }
                }
                
                this.updateUIState();
                this.updateInspector();
                this.renderSidebarSessionList();

                // Connect SSE stream for live updates
                this.connectStream(sessionId);
            }
        } catch (error) {
            console.error('[RXCAFE] Failed to switch session:', error);
            this.showError('Failed to switch session');
        }
    }

    connectStream(sessionId) {
        console.log(`[RXCAFE] connectStream: ${sessionId}`);
        this.disconnectStream();

        const url = this.apiUrl(`/api/session/${sessionId}/stream`);
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

                if (data.type === 'chunk') {
                    const chunk = data.chunk;
                    const role = chunk.annotations?.['chat.role'];

                    // Check for session naming annotation
                    if (chunk.annotations?.['session.name']) {
                        const newName = chunk.annotations['session.name'];
                        console.log(`[RXCAFE] Session renamed to: ${newName}`);
                        const session = this.knownSessions.find(s => s.id === this.sessionId);
                        if (session) {
                            session.displayName = newName;
                            
                            // Update Sidebar if visible
                            if (this.sessionsSidebar.style.display === 'flex') {
                                this.renderSidebarSessionList();
                            }
                            
                            // Update header info if it's the current session
                            const info = [];
                            info.push(newName);
                            if (this.backend) info.push(this.backend);
                            if (this.model) info.push(this.model);
                            if (this.isBackground) info.push('[background]');
                            this.backendInfoEl.textContent = info.join(' | ');
                        }
                    }

                    if (this.chunkElements.has(chunk.id)) {
                        const el = this.chunkElements.get(chunk.id);
                        if (el) {
                            console.log(`[RXCAFE] SSE: Updating existing chunk UI:`, chunk.id);
                            
                            // 1. Sync annotations (like sentiment)
                            if (chunk.annotations['com.rxcafe.example.sentiment']) {
                                this.updateSentiment(el, chunk.annotations['com.rxcafe.example.sentiment']);
                            }
                            
                            // 2. Sync text content if it changed (e.g. tool results)
                            if (chunk.contentType === 'text' && !el.classList.contains('streaming')) {
                                this.updateMessageContent(el, chunk.content, chunk.annotations);
                                
                                // Re-append sentiment if it was there
                                const contentEl = el.querySelector('.message-content');
                                if (chunk.annotations['com.rxcafe.example.sentiment']) {
                                    this.updateSentiment(el, chunk.annotations['com.rxcafe.example.sentiment']);
                                }
                            }
                        }
                        this.addRawChunk(chunk);
                        return;
                    }

                    // Check if this matches a pending eagerly-rendered element
                    if (role === 'user' && this._pendingUserMsg) {
                        console.log(`[RXCAFE] SSE user chunk claimed by pending element elId=${this._pendingUserMsg.dataset.elId}, registering id:`, chunk.id);
                        this._pendingUserMsg.dataset.chunkId = chunk.id;
                        this.chunkElements.set(chunk.id, this._pendingUserMsg);
                        
                        // Display sentiment if present
                        if (chunk.annotations['com.rxcafe.example.sentiment']) {
                            this.updateSentiment(this._pendingUserMsg, chunk.annotations['com.rxcafe.example.sentiment']);
                        }

                        this._pendingUserMsg = null;
                        this.addRawChunk(chunk);
                        this.updateInspector();
                        return;
                    }



                    const assistantEl = (this.currentMessageEl?.dataset.pendingAssistant ? this.currentMessageEl : null) 
                                        || (this._lastAssistantEl?.dataset.pendingAssistant ? this._lastAssistantEl : null);

                    if (role === 'assistant' && assistantEl && chunk.contentType === 'text') {
                        console.log(`[RXCAFE] SSE assistant chunk claimed by element elId=${assistantEl.dataset.elId}, registering id:`, chunk.id);
                        assistantEl.dataset.chunkId = chunk.id;
                        this.chunkElements.set(chunk.id, assistantEl);
                        assistantEl.dataset.annotations = JSON.stringify(chunk.annotations || {});
                        this.updateMessageContent(assistantEl, chunk.content, chunk.annotations);
                        delete assistantEl.dataset.pendingAssistant;
                        if (assistantEl === this._lastAssistantEl) this._lastAssistantEl = null;
                        this.addRawChunk(chunk);
                        this.updateInspector();
                        return;
                    }

                    console.log(`[RXCAFE] New chunk from stream, rendering:`, chunk.id, chunk.content?.slice?.(0, 60));
                    this.addRawChunk(chunk);
                    this.renderChunk(chunk);
                    this.updateInspector();
                }
            } catch (e) {
                console.error('[RXCAFE] SSE parse error:', e, event.data);
            }
        };

        es.onerror = (err) => {
            // Guard: ignore stale closures from replaced connections
            if (es !== this.eventSource) return;

            console.warn(`[RXCAFE] SSE error/disconnect for session ${sessionId}`, err);
            es.close();
            this.eventSource = null;

            if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
            this._reconnectTimer = setTimeout(() => {
                this._reconnectTimer = null;
                if (this.sessionId === sessionId) {
                    console.log(`[RXCAFE] Reconnecting SSE for ${sessionId}...`);
                    this.connectStream(sessionId);
                }
            }, 3000);
        };
    }

    disconnectStream() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this.eventSource) {
            console.log(`[RXCAFE] disconnectStream: closing EventSource`);
            this.eventSource.close();
            this.eventSource = null;
        }
    }
    
    renderChunk(chunk) {
        const role = chunk.annotations?.['chat.role'];
        const isWeb = chunk.producer === 'com.rxcafe.web-fetch' || chunk.annotations?.['web.source-url'];
        const isSystem = role === 'system';
        const isTelegram = chunk.annotations?.['client.type'] === 'telegram';
        
        // Skip purely metadata chunks (like session naming) if they don't have a role
        if (!role && chunk.annotations?.['session.name']) {
            this.chunkElements.set(chunk.id, null); // Mark as processed
            return;
        }

        console.log(`[RXCAFE] renderChunk (from ${new Error().stack.split('\n')[2].trim()}) id=${chunk.id} role=${role} content="${String(chunk.content ?? '').slice(0,60)}"`);
        
        if (chunk.contentType === 'binary') {
            const mimeType = chunk.content?.mimeType || '';
            if (mimeType.startsWith('image/')) {
                this.addImageMessage(role || 'assistant', chunk);
            } else if (mimeType.startsWith('audio/')) {
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
                const el = this.addMessage('user', chunk.content, chunk.id, chunk.annotations);
                
                // Show Telegram origin
                if (isTelegram) {
                    this.addTelegramLabel(el);
                }

                // Handle sentiment for history chunks
                if (chunk.annotations && chunk.annotations['com.rxcafe.example.sentiment']) {
                    this.updateSentiment(el, chunk.annotations['com.rxcafe.example.sentiment']);
                }
            } else if (role === 'assistant') {
                this.addMessage('assistant', chunk.content, chunk.id, chunk.annotations);
            }
        }
    }

    addTelegramLabel(messageEl) {
        if (!messageEl) return;
        let labelEl = messageEl.querySelector('.telegram-label');
        if (!labelEl) {
            labelEl = document.createElement('div');
            labelEl.className = 'message-meta telegram-label';
            labelEl.textContent = 'via Telegram';
            labelEl.style.fontSize = '0.65rem';
            labelEl.style.marginTop = '0.2rem';
            labelEl.style.fontStyle = 'italic';
            labelEl.style.textAlign = 'right';
            labelEl.style.opacity = '0.8';
            messageEl.querySelector('.message-content').appendChild(labelEl);
        }
    }
    
    hideBackendModal() {
        this.backendModal.style.display = 'none';
    }
    
    async createSession() {
        const selectedBackend = document.querySelector('input[name="backend"]:checked')?.value || 'kobold';
        const selectedModel = selectedBackend === 'ollama' ? this.ollamaModelSelect.value : undefined;
        const selectedAgent = this.agentSelect.value || 'default';
        
        // Get advanced options
        const temperature = this.temperatureInput.value ? parseFloat(this.temperatureInput.value) : undefined;
        const maxTokens = this.maxTokensInput.value ? parseInt(this.maxTokensInput.value) : undefined;
        const systemPrompt = this.systemPromptInput.value.trim() || undefined;
        
        const llmParams = (temperature || maxTokens) ? {} : undefined;
        if (temperature !== undefined) llmParams.temperature = temperature;
        if (maxTokens !== undefined) llmParams.maxTokens = maxTokens;
        
        try {
            const response = await fetch(this.apiUrl('/api/session'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    backend: selectedBackend,
                    model: selectedModel,
                    agentId: selectedAgent,
                    llmParams,
                    systemPrompt
                })
            });
            
            const data = await response.json();
            
            if (data.sessionId) {
                this.sessionId = data.sessionId;
                this.backend = data.backend;
                this.model = data.model;
                this.agentName = data.agentName;
                this.isBackground = data.isBackground;
                
                // Add to known sessions
                const existingIndex = this.knownSessions.findIndex(s => s.id === data.sessionId);
                if (existingIndex === -1) {
                    this.knownSessions.push({
                        id: data.sessionId,
                        agentName: data.agentName,
                        isBackground: data.isBackground
                    });
                }
                
                const info = [];
                info.push(this.agentName);
                if (this.backend) info.push(this.backend);
                if (this.model) info.push(this.model);
                if (this.isBackground) info.push('[background]');
                this.backendInfoEl.textContent = info.join(' | ');
                
                this.updateUIState();
                this.messagesEl.innerHTML = '';
                this.chunkElements.clear();
                this.rawChunks = [];
                this.addSystemMessage(`Session created: ${this.agentName}`);
                if (this.backend) {
                    this.addSystemMessage(`Backend: ${this.backend}${this.model ? ' (' + this.model + ')' : ''}`);
                }
                this.addSystemMessage('Commands: /web URL | /system prompt | /addchunk JSON');
                this.hideBackendModal();
                this.messageInput.focus();
                this.updateInspector();
                // Connect SSE stream for live updates
                this.connectStream(data.sessionId);
            }
        } catch (error) {
            console.error('Failed to create session:', error);
            this.showError('Failed to create session. Is the server running?');
        }
    }
    
    async sendMessage() {
        if (!this.sessionId) {
            this.showBackendModal();
            return;
        }
        
        const message = this.messageInput.value.trim();
        if (!message || this.isGenerating) return;
        
        // Check for slash commands
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
        
        // Regular message - render eagerly but mark as pending so SSE dedup works.
        // We don't know the real chunk id yet; use a sentinel that SSE will overwrite.
        this._pendingUserMsg = this.createMessageElement('user', message);
        this._pendingUserMsg.dataset.pendingUser = 'true';
        this.messagesEl.appendChild(this._pendingUserMsg);
        this.scrollToBottom();
        this.messageInput.value = '';
        this.messageInput.style.height = 'auto';
        this.messageInput.focus();
        
        // Start generation
        this.isGenerating = true;
        this.updateUIState();
        
        // Create streaming message container - mark as pending so SSE skips it
        this.currentMessageEl = this.createMessageElement('assistant', '');
        this.currentMessageEl.classList.add('streaming');
        this.currentMessageEl.dataset.pendingAssistant = 'true';
        this.currentContent = '';
        
        // Add loading indicator
        const loadingEl = document.createElement('div');
        loadingEl.className = 'loading-indicator';
        loadingEl.innerHTML = '<span></span><span></span><span></span>';
        this.currentMessageEl.querySelector('.message-content').appendChild(loadingEl);
        
        this.messagesEl.appendChild(this.currentMessageEl);
        this.scrollToBottom();

        try {
            const response = await fetch(this.apiUrl(`/api/chat/${this.sessionId}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message })
            });
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            
            // Remove loading indicator only if we haven't received content from SSE yet
            const contentEl = this.currentMessageEl.querySelector('.message-content');
            const loadingEl = contentEl?.querySelector('.loading-indicator');
            if (loadingEl) {
                console.log('[RXCAFE] Removing loading indicator');
                loadingEl.remove();
            }
            
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
                            this.handleStreamData(data);
                        } catch (e) {
                            console.error('Failed to parse SSE data:', e);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Streaming error:', error);
            this.showErrorInMessage(this.currentMessageEl, 'Failed to get response. Check if the LLM server is running.');
        } finally {
            this.isGenerating = false;
            if (this.currentMessageEl) {
                this.currentMessageEl.classList.remove('streaming');
                
                // If it's still pending (not claimed by SSE yet), keep it for a short window
                // so a late-arriving SSE chunk can still claim it.
                if (this.currentMessageEl.dataset.pendingAssistant) {
                    this._lastAssistantEl = this.currentMessageEl;
                    
                    // Safety check: if no content arrived after 5s, remove the empty bubble
                    const el = this.currentMessageEl;
                    setTimeout(() => {
                        if (el.parentElement && el.dataset.pendingAssistant && !el.dataset.chunkId) {
                            console.log('[RXCAFE] Removing unclaimed empty assistant bubble');
                            el.remove();
                        }
                    }, 5000);
                }
            }
            this.currentMessageEl = null;
            this.currentContent = '';
            this.updateUIState();
            this.messageInput.focus();
        }
    }
    
    async handleWebCommand(url) {
        if (!url) {
            this.showError('Please provide a URL: /web https://example.com');
            return;
        }
        
        // Show fetching indicator
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
            
            // Remove loading indicator
            loadingEl.remove();
            
            if (data.success && data.chunk) {
                this.addWebChunk(data.chunk);
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
                this.addSystemChunk(data.chunk, prompt);
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
            
            if (!parsed.content) {
                this.showError('Chunk must have content field');
                return;
            }
            
            const response = await fetch(this.apiUrl(`/api/session/${this.sessionId}/chunk`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: parsed.content,
                    producer: parsed.producer || 'com.rxcafe.user',
                    annotations: parsed.annotations || {}
                })
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
    
    addSystemChunk(chunk, prompt) {
        this.addRawChunk(chunk);
        
        const messageEl = document.createElement('div');
        messageEl.className = 'message system-prompt';
        messageEl.dataset.chunkId = chunk.id;
        
        const headerEl = document.createElement('div');
        headerEl.className = 'system-header';
        headerEl.innerHTML = '<span class="system-label">⚙️ System Prompt</span>';
        
        const contentEl = document.createElement('div');
        contentEl.className = 'message-content';
        contentEl.textContent = prompt;
        
        messageEl.appendChild(headerEl);
        messageEl.appendChild(contentEl);
        
        this.messagesEl.appendChild(messageEl);
        this.chunkElements.set(chunk.id, messageEl);
        this.scrollToBottom();
    }
    
    addWebChunk(chunk) {
        this.addRawChunk(chunk);
        
        const isTrusted = chunk.annotations?.['security.trust-level']?.trusted === true;
        const sourceUrl = chunk.annotations?.['web.source-url'] || 'Unknown source';
        
        const messageEl = document.createElement('div');
        messageEl.className = `message web ${isTrusted ? 'trusted' : 'untrusted'}`;
        messageEl.dataset.chunkId = chunk.id;
        
        const headerEl = document.createElement('div');
        headerEl.className = 'web-header';
        
        const sourceEl = document.createElement('span');
        sourceEl.className = 'web-source';
        sourceEl.textContent = `Web: ${sourceUrl}`;
        
        const trustBadge = document.createElement('span');
        trustBadge.className = `trust-badge ${isTrusted ? 'trusted' : 'untrusted'}`;
        trustBadge.textContent = isTrusted ? 'Trusted' : 'Untrusted';
        
        const trustToggle = document.createElement('button');
        trustToggle.className = 'trust-toggle';
        trustToggle.textContent = isTrusted ? 'Untrust' : 'Trust';
        trustToggle.onclick = () => this.toggleTrustFromButton(chunk.id, !isTrusted);
        
        headerEl.appendChild(sourceEl);
        headerEl.appendChild(trustBadge);
        headerEl.appendChild(trustToggle);
        
        const contentEl = document.createElement('div');
        contentEl.className = 'message-content';
        contentEl.textContent = chunk.content;
        
        messageEl.appendChild(headerEl);
        messageEl.appendChild(contentEl);
        
        // Right-click context menu
        messageEl.addEventListener('contextmenu', (e) => this.showContextMenu(e, chunk.id));
        
        this.messagesEl.appendChild(messageEl);
        this.chunkElements.set(chunk.id, messageEl);
        this.scrollToBottom();
        
        if (!isTrusted) {
            this.addSystemMessage('Web content added but NOT trusted. Right-click and select "Trust Chunk" to include in LLM context, or click the Trust button.');
        }
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
    
    handleStreamData(data) {
        switch (data.type) {
            case 'user':
                if (data.chunk) {
                    this.addRawChunk(data.chunk);
                }
                break;
            case 'token':
                if (data.token) {
                    this.currentContent += data.token;
                    const annotations = this.currentMessageEl?.dataset.annotations ? JSON.parse(this.currentMessageEl.dataset.annotations) : {};
                    this.updateMessageContent(this.currentMessageEl, this.currentContent, annotations);
                }
                break;
            case 'error':
                this.showErrorInMessage(this.currentMessageEl, data.error);
                break;
            case 'finish':
                break;
            case 'done':
                break;
        }
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

    copySessionId() {
        if (!this.sessionId) return;
        navigator.clipboard.writeText(this.sessionId).then(() => {
            const originalText = this.copySessionIdBtn.textContent;
            this.copySessionIdBtn.textContent = '✅';
            setTimeout(() => {
                this.copySessionIdBtn.textContent = originalText;
            }, 2000);
        });
    }
    
    addMessage(role, content, chunkId = null, annotations = {}) {
        const messageEl = this.createMessageElement(role, content, annotations);
        console.log(`[RXCAFE] addMessage elId=${messageEl.dataset.elId} role=${role} chunkId=${chunkId}`);
        if (chunkId) {
            messageEl.dataset.chunkId = chunkId;
            this.chunkElements.set(chunkId, messageEl);
        }
        this.messagesEl.appendChild(messageEl);
        this.scrollToBottom();
        return messageEl;
    }

    updateSentiment(messageEl, sentiment) {
        if (!messageEl || !sentiment) return;
        console.log('[RXCAFE] updateSentiment called for element:', messageEl.dataset.elId, sentiment);
        
        let metaEl = messageEl.querySelector('.sentiment-meta');
        if (!metaEl) {
            metaEl = document.createElement('div');
            metaEl.className = 'message-meta sentiment-meta';
            metaEl.style.fontSize = '0.7rem';
            metaEl.style.marginTop = '0.4rem';
            metaEl.style.padding = '0.4rem';
            metaEl.style.backgroundColor = 'rgba(0,0,0,0.05)';
            metaEl.style.borderRadius = '0.25rem';
            messageEl.querySelector('.message-content').appendChild(metaEl);
        }
        
        const score = parseFloat(sentiment.score) || 0;
        const emoji = score > 0.3 ? '😊' : (score < -0.3 ? '☹️' : '😐');
        metaEl.textContent = `Sentiment: ${emoji} (${score.toFixed(2)}) - ${sentiment.explanation}`;
    }

    addImageMessage(role, chunk) {
        if (!chunk.content || !chunk.content.data) {
            console.error('[RXCAFE] Binary chunk missing data', chunk);
            return;
        }
        const { data, mimeType } = chunk.content;
        
        // Convert numeric array/object to Uint8Array
        let uint8;
        if (data instanceof Uint8Array) {
            uint8 = data;
        } else if (Array.isArray(data)) {
            uint8 = new Uint8Array(data);
        } else if (typeof data === 'object' && data !== null) {
            // Check if it is a Buffer-like object with .data array
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
        
        const messageEl = document.createElement('div');
        this._elCounter++;
        messageEl.dataset.elId = this._elCounter;
        messageEl.dataset.chunkId = chunk.id;
        messageEl.className = `message ${role} image-message`;
        
        const contentEl = document.createElement('div');
        contentEl.className = 'message-content';
        
        const img = document.createElement('img');
        img.src = url;
        img.alt = chunk.annotations?.['image.description'] || 'Generated image';
        img.style.maxWidth = '100%';
        img.style.borderRadius = '0.5rem';
        img.style.display = 'block';
        
        // Revoke object URL when image is loaded to save memory
        img.onload = () => URL.revokeObjectURL(url);
        
        contentEl.appendChild(img);
        
        if (chunk.annotations?.['image.description']) {
            const caption = document.createElement('div');
            caption.className = 'message-meta';
            caption.textContent = chunk.annotations['image.description'];
            contentEl.appendChild(caption);
        }
        
        messageEl.appendChild(contentEl);
        this.messagesEl.appendChild(messageEl);
        this.chunkElements.set(chunk.id, messageEl);
        this.scrollToBottom();
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
        
        const messageEl = document.createElement('div');
        this._elCounter++;
        messageEl.dataset.elId = this._elCounter;
        messageEl.dataset.chunkId = chunk.id;
        messageEl.className = `message ${role} audio-message`;
        
        const contentEl = document.createElement('div');
        contentEl.className = 'message-content';
        
        const audio = document.createElement('audio');
        audio.src = url;
        audio.controls = true;
        audio.style.width = '100%';
        audio.style.display = 'block';
        
        contentEl.appendChild(audio);
        
        if (chunk.annotations?.['audio.description']) {
            const caption = document.createElement('div');
            caption.className = 'message-meta';
            caption.textContent = chunk.annotations['audio.description'];
            contentEl.appendChild(caption);
        }
        
        messageEl.appendChild(contentEl);
        this.messagesEl.appendChild(messageEl);
        this.chunkElements.set(chunk.id, messageEl);
        this.scrollToBottom();
    }
    
    createMessageElement(role, content, annotations = {}) {
        const messageEl = document.createElement('div');
        this._elCounter++;
        messageEl.dataset.elId = this._elCounter;
        messageEl.className = `message ${role}`;
        
        const contentEl = document.createElement('div');
        contentEl.className = 'message-content';
        
        const bodyEl = document.createElement('div');
        bodyEl.className = 'message-body';
        this.renderMessageBody(bodyEl, content, annotations);
        
        contentEl.appendChild(bodyEl);
        messageEl.appendChild(contentEl);
        return messageEl;
    }

    renderMessageBody(el, content, annotations) {
        if (annotations['parsers.markdown.enabled'] && typeof marked !== 'undefined') {
            el.innerHTML = marked.parse(content);
        } else {
            el.textContent = content;
        }
    }
    
    updateMessageContent(messageEl, content, annotations = {}) {
        const bodyEl = messageEl.querySelector('.message-body');
        if (bodyEl) {
            this.renderMessageBody(bodyEl, content, annotations);
            this.scrollToBottom();
        }
    }
    
    showErrorInMessage(messageEl, error) {
        const contentEl = messageEl.querySelector('.message-content');
        if (contentEl) {
            contentEl.innerHTML = `<span style="color: #dc2626;">Error: ${error}</span>`;
        }
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
    
    updateUIState() {
        this.sendBtn.style.display = this.isGenerating ? 'none' : 'block';
        this.abortBtn.style.display = this.isGenerating ? 'block' : 'none';
        this.messageInput.disabled = this.isGenerating || !this.sessionId;
        this.copySessionIdBtn.style.display = this.sessionId ? 'inline-block' : 'none';
    }
    
    toggleInspector() {
        const isVisible = this.inspectorPanel.classList.contains('visible');
        if (isVisible) {
            this.hideInspector();
        } else {
            this.showInspector();
        }
    }

    showInspector() {
        this.inspectorVisible = true;
        this.inspectorPanel.style.display = 'flex';
        setTimeout(() => {
            this.inspectorPanel.classList.add('visible');
        }, 10);
        if (window.innerWidth <= 800 && this.inspectorOverlay) {
            this.inspectorOverlay.style.display = 'block';
        }
        this.updateInspector();
    }

    hideInspector() {
        this.inspectorVisible = false;
        this.inspectorPanel.classList.remove('visible');
        if (window.innerWidth <= 800) {
            if (this.inspectorOverlay) {
                this.inspectorOverlay.style.display = 'none';
            }
            setTimeout(() => {
                if (!this.inspectorPanel.classList.contains('visible')) {
                    this.inspectorPanel.style.display = 'none';
                }
            }, 300);
        }
    }

    async showSessionsModal() {
        this.sessionsModal.style.display = 'flex';
        await this.loadSessions();
        this.renderSessionList();
    }

    hideSessionsModal() {
        this.sessionsModal.style.display = 'none';
    }

    toggleSessionsSidebar() {
        const isVisible = this.sessionsSidebar.classList.contains('visible');
        if (isVisible) {
            this.hideSessionsSidebar();
        } else {
            this.showSessionsSidebar();
        }
    }

    showSessionsSidebar() {
        this.sessionsSidebar.style.display = 'flex';
        // Use a small timeout to ensure display: flex is applied before adding visible class for transition
        setTimeout(() => {
            this.sessionsSidebar.classList.add('visible');
        }, 10);

        if (window.innerWidth <= 800 && this.sessionsSidebarOverlay) {
            this.sessionsSidebarOverlay.style.display = 'block';
        }
        this.renderSidebarSessionList();
    }

    hideSessionsSidebar() {
        this.sessionsSidebar.classList.remove('visible');
        
        if (window.innerWidth <= 800) {
            if (this.sessionsSidebarOverlay) {
                this.sessionsSidebarOverlay.style.display = 'none';
            }
            // On mobile, hide display after transition
            setTimeout(() => {
                if (!this.sessionsSidebar.classList.contains('visible')) {
                    this.sessionsSidebar.style.display = 'none';
                }
            }, 300);
        }
        // On desktop we keep it display: flex but transform handles it
    }

    showSidebarMenu(e, sessionId) {
        e.stopPropagation();
        this.sidebarMenuSessionId = sessionId;
        this.sidebarMenu.style.display = 'block';
        
        const rect = e.target.getBoundingClientRect();
        const menuWidth = 140; // Default min-width + padding
        
        // Position horizontally: align right edge of menu with right edge of button
        // if it would overflow the screen, otherwise just use rect.left
        let left = rect.right - menuWidth;
        if (left < 10) left = 10; // Keep some margin from left
        
        this.sidebarMenu.style.left = `${left}px`;
        this.sidebarMenu.style.top = `${rect.bottom + window.scrollY}px`;
    }

    hideSidebarMenu() {
        this.sidebarMenu.style.display = 'none';
        this.sidebarMenuSessionId = null;
    }

    async renameSessionFromMenu() {
        const sessionId = this.sidebarMenuSessionId;
        this.hideSidebarMenu();
        if (sessionId) {
            await this.renameSession(sessionId);
        }
    }

    async deleteSessionFromMenu() {
        const sessionId = this.sidebarMenuSessionId;
        this.hideSidebarMenu();
        if (sessionId) {
            await this.deleteSession(sessionId);
        }
    }

    renderSidebarSessionList() {
        if (this.knownSessions.length === 0) {
            this.sidebarSessionList.innerHTML = '<p>No sessions found.</p>';
            return;
        }

        this.sidebarSessionList.innerHTML = this.knownSessions.map(s => {
            const isCurrent = s.id === this.sessionId;
            const displayName = s.displayName || s.agentName;
            const shortId = s.id.length > 20 ? '...' + s.id.slice(-6) : s.id;
            
            return `
                <div class="sidebar-session-item ${isCurrent ? 'active' : ''}" onclick="chat.switchToSessionFromSidebar('${s.id}')">
                    <div class="sidebar-session-info">
                        <div class="sidebar-session-name">${displayName}${s.isBackground ? ' [bg]' : ''}</div>
                        <div class="sidebar-session-meta">${s.agentName} • ${shortId}</div>
                    </div>
                    <button class="sidebar-session-more-btn" onclick="chat.showSidebarMenu(event, '${s.id}')">⋮</button>
                </div>
            `;
        }).join('');
    }

    async switchToSessionFromSidebar(sessionId) {
        if (sessionId === this.sessionId) return;
        await this.switchToSession(sessionId);
        if (window.innerWidth <= 800) {
            this.hideSessionsSidebar();
        }
    }

    renderSessionList() {
        if (this.knownSessions.length === 0) {
            this.sessionList.innerHTML = '<p>No sessions found.</p>';
            return;
        }

        this.sessionList.innerHTML = this.knownSessions.map(s => {
            const isCurrent = s.id === this.sessionId;
            const displayName = s.displayName || s.agentName;
            const bg = s.isBackground ? ' [background]' : '';
            const shortId = s.id.length > 20 ? '...' + s.id.slice(-6) : s.id;
            
            return `
                <div class="session-item ${isCurrent ? 'active' : ''}">
                    <div class="session-item-info">
                        <div class="session-item-name">${displayName}${bg}</div>
                        <div class="session-item-details">${shortId} • ${s.agentName}</div>
                    </div>
                    <div class="session-item-actions">
                        ${!isCurrent ? `<button class="btn btn-primary btn-small" onclick="chat.switchToSessionFromModal('${s.id}')">Switch</button>` : ''}
                        <button class="btn btn-secondary btn-small" onclick="chat.renameSession('${s.id}')">Rename</button>
                        <button class="btn btn-danger btn-small" onclick="chat.deleteSession('${s.id}')">Delete</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    async switchToSessionFromModal(sessionId) {
        await this.switchToSession(sessionId);
        this.hideSessionsModal();
    }

    async renameSession(sessionId) {
        const session = this.knownSessions.find(s => s.id === sessionId);
        const currentName = session ? (session.displayName || session.agentName) : '';
        const newName = prompt('Enter new session name:', currentName);
        
        if (newName === null || newName === currentName) return;

        try {
            const response = await fetch(this.apiUrl(`/api/session/${sessionId}/chunk`), {
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
                // The update will come back via SSE or be handled by addRawChunk if it's the current session
                if (session) {
                    session.displayName = newName;
                    
                    // Update Sidebar if visible
                    if (this.sessionsSidebar.style.display === 'flex') {
                        this.renderSidebarSessionList();
                    }

                    this.renderSessionList();
                }
            } else {
                this.showError(data.message || 'Failed to rename session');
            }
        } catch (error) {
            console.error('Failed to rename session:', error);
            this.showError('Error renaming session');
        }
    }

    async deleteSession(sessionId) {
        if (!confirm('Are you sure you want to delete this session? History will be lost.')) return;
        console.log(`[RXCAFE] Deleting session: ${sessionId}`);

        try {
            const response = await fetch(this.apiUrl(`/api/session/${sessionId}`), {
                method: 'DELETE'
            });
            const data = await response.json();
            console.log(`[RXCAFE] Delete response:`, data);

            if (data.success) {
                if (this.sessionId === sessionId) {
                    console.log('[RXCAFE] Deleted current session, clearing UI');
                    this.sessionId = null;
                    if (window.location.hash.substring(1) === sessionId) {
                        history.replaceState(null, null, ' '); // Clear hash without adding to history
                    }
                    this.messagesEl.innerHTML = '<div class="welcome-message"><h2>Session Deleted</h2><p>Please create or select another session.</p></div>';
                    this.backendInfoEl.textContent = 'No session';
                    this.messageInput.disabled = true;
                    this.sendBtn.disabled = true;
                    this.disconnectStream();
                }
                await this.loadSessions();
                
                // Update Sidebar if visible
                if (this.sessionsSidebar.style.display === 'flex') {
                    this.renderSidebarSessionList();
                }

                console.log('[RXCAFE] Session list updated after delete');
            } else {
                this.showError(data.message || 'Failed to delete session');
            }
        } catch (error) {
            console.error('Failed to delete session:', error);
            this.showError('Error deleting session');
        }
    }
    
    addRawChunk(chunk) {
        // Check for session naming annotation
        if (chunk.annotations?.['session.name']) {
            const newName = chunk.annotations['session.name'];
            const session = this.knownSessions.find(s => s.id === this.sessionId);
            if (session) {
                session.displayName = newName;
                
                // Update Sidebar if visible
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
        this.inspectorSession.textContent = JSON.stringify({
            sessionId: this.sessionId,
            agentName: this.agentName,
            backend: this.backend,
            model: this.model,
            isBackground: this.isBackground
        }, null, 2);
        
        this.inspectorChunkCount.textContent = this.rawChunks.length;
        
        this.inspectorChunks.innerHTML = this.rawChunks.map(chunk => {
            const role = this.getChunkRole(chunk);
            const trustStatus = chunk.annotations?.['security.trust-level']?.trusted;
            const roleClass = trustStatus !== undefined 
                ? (trustStatus ? 'trusted' : 'untrusted')
                : role;
            
            return `
                <div class="inspector-chunk" data-chunk-id="${chunk.id}">
                    <div class="inspector-chunk-header" onclick="this.parentElement.classList.toggle('expanded')">
                        <span class="inspector-chunk-id">${chunk.id.split('-').slice(-2).join('-')}</span>
                        <span class="inspector-chunk-role ${roleClass}">${role}</span>
                    </div>
                    <div class="inspector-chunk-body">
                        <pre>${this.escapeHtml(JSON.stringify(chunk, null, 2))}</pre>
                    </div>
                </div>
            `;
        }).join('');
    }
    
    getChunkRole(chunk) {
        const role = chunk.annotations?.['chat.role'];
        if (role === 'system') return 'system';
        if (role) return role;
        if (chunk.producer === 'com.rxcafe.web-fetch' || chunk.annotations?.['web.source-url']) return 'web';
        if (chunk.producer.includes('kobold') || chunk.producer.includes('ollama') || chunk.producer === 'com.rxcafe.assistant') return 'assistant';
        return chunk.producer.split('.').pop();
    }
    
    escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    
    scrollToBottom() {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
}

let chat;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    chat = new RXCafeChat();
});
