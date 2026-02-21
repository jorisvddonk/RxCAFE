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
        this.chunkElements = new Map(); // Map chunk IDs to DOM elements
        this.rawChunks = []; // Store raw chunk data for inspector
        this.contextMenuChunkId = null;
        this.token = this.getToken();
        this.inspectorVisible = false;
        this.agents = [];
        
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
    }
    
    cacheElements() {
        this.backendInfoEl = document.getElementById('backend-info');
        this.newSessionBtn = document.getElementById('new-session-btn');
        this.messagesEl = document.getElementById('messages');
        this.messageInput = document.getElementById('message-input');
        this.sendBtn = document.getElementById('send-btn');
        this.abortBtn = document.getElementById('abort-btn');
        
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
        this.inspectorToggleBtn = document.getElementById('inspector-toggle-btn');
        this.inspectorCloseBtn = document.getElementById('inspector-close-btn');
        this.inspectorSession = document.getElementById('inspector-session');
        this.inspectorChunkCount = document.getElementById('inspector-chunk-count');
        this.inspectorChunks = document.getElementById('inspector-chunks');
    }
    
    bindEvents() {
        this.newSessionBtn.addEventListener('click', () => this.showBackendModal());
        this.createSessionBtn.addEventListener('click', () => this.createSession());
        this.cancelBtn.addEventListener('click', () => this.hideBackendModal());
        this.sendBtn.addEventListener('click', () => this.sendMessage());
        this.abortBtn.addEventListener('click', () => this.abortGeneration());
        
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
        
        // Load agents
        await this.loadAgents();
        
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
                
                const info = [];
                info.push(this.agentName);
                if (this.backend) info.push(this.backend);
                if (this.model) info.push(this.model);
                if (this.isBackground) info.push('[background]');
                this.backendInfoEl.textContent = info.join(' | ');
                
                this.messageInput.disabled = false;
                this.sendBtn.disabled = false;
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
        
        // Regular message
        this.addMessage('user', message);
        this.messageInput.value = '';
        this.messageInput.style.height = 'auto';
        this.messageInput.focus();
        
        // Start generation
        this.isGenerating = true;
        this.updateUIState();
        
        // Create streaming message container
        this.currentMessageEl = this.createMessageElement('assistant', '');
        this.currentMessageEl.classList.add('streaming');
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
            
            // Remove loading indicator
            const contentEl = this.currentMessageEl.querySelector('.message-content');
            contentEl.innerHTML = '';
            
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
            this.currentMessageEl.classList.remove('streaming');
            if (this.currentContent && this.sessionId) {
                this.addRawChunk({
                    id: `assistant-${Date.now()}`,
                    timestamp: Date.now(),
                    contentType: 'text',
                    content: this.currentContent,
                    producer: 'com.rxcafe.assistant',
                    annotations: { 'chat.role': 'assistant' }
                });
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
                    this.updateMessageContent(this.currentMessageEl, this.currentContent);
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
    
    addMessage(role, content) {
        const messageEl = this.createMessageElement(role, content);
        this.messagesEl.appendChild(messageEl);
        this.scrollToBottom();
    }
    
    createMessageElement(role, content) {
        const messageEl = document.createElement('div');
        messageEl.className = `message ${role}`;
        
        const contentEl = document.createElement('div');
        contentEl.className = 'message-content';
        contentEl.textContent = content;
        
        messageEl.appendChild(contentEl);
        return messageEl;
    }
    
    updateMessageContent(messageEl, content) {
        const contentEl = messageEl.querySelector('.message-content');
        if (contentEl) {
            contentEl.textContent = content;
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
    }
    
    toggleInspector() {
        this.inspectorVisible = !this.inspectorVisible;
        this.inspectorPanel.style.display = this.inspectorVisible ? 'flex' : 'none';
        if (this.inspectorVisible) {
            this.updateInspector();
        }
    }
    
    hideInspector() {
        this.inspectorVisible = false;
        this.inspectorPanel.style.display = 'none';
    }
    
    addRawChunk(chunk) {
        const existingIndex = this.rawChunks.findIndex(c => c.id === chunk.id);
        if (existingIndex !== -1) {
            this.rawChunks[existingIndex] = chunk;
        } else {
            this.rawChunks.push(chunk);
        }
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

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new RXCafeChat();
});
