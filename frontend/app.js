/**
 * RXCAFE Chat Frontend
 * Simple chat interface for the RXCAFE API
 * Supports both KoboldCPP and Ollama backends
 */

class RXCafeChat {
    constructor() {
        this.sessionId = null;
        this.backend = null;
        this.model = null;
        this.isGenerating = false;
        this.currentMessageEl = null;
        this.currentContent = '';
        
        this.init();
    }
    
    init() {
        this.cacheElements();
        this.bindEvents();
        this.autoResize();
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
    }
    
    async loadOllamaModels(backend) {
        if (!backend) return;
        
        // Show loading state
        this.ollamaModelSelect.innerHTML = '<option value="">Loading models...</option>';
        this.ollamaModelSelect.disabled = true;
        
        try {
            const response = await fetch(`/api/models?backend=${backend}`);
            const data = await response.json();
            
            if (data.models && data.models.length > 0) {
                this.ollamaModelSelect.innerHTML = data.models
                    .map(m => `<option value="${m}">${m}</option>`)
                    .join('');
                this.ollamaModelSelect.disabled = false;
            } else {
                this.ollamaModelSelect.innerHTML = '<option value="llama2">llama2</option>';
                this.ollamaModelSelect.disabled = false;
            }
        } catch (error) {
            console.error('Failed to load models:', error);
            this.ollamaModelSelect.innerHTML = '<option value="llama2">llama2 (default)</option>';
            this.ollamaModelSelect.disabled = false;
        }
    }
    
    autoResize() {
        this.messageInput.addEventListener('input', () => {
            this.messageInput.style.height = 'auto';
            this.messageInput.style.height = Math.min(this.messageInput.scrollHeight, 200) + 'px';
        });
    }
    
    showBackendModal() {
        this.backendModal.style.display = 'flex';
        
        // Check if Ollama is selected and load models
        const selectedBackend = document.querySelector('input[name="backend"]:checked')?.value;
        if (selectedBackend === 'ollama') {
            this.loadOllamaModels('ollama');
        }
    }
    
    hideBackendModal() {
        this.backendModal.style.display = 'none';
    }
    
    async createSession() {
        const selectedBackend = document.querySelector('input[name="backend"]:checked')?.value || 'kobold';
        const selectedModel = selectedBackend === 'ollama' ? this.ollamaModelSelect.value : undefined;
        
        try {
            const response = await fetch('/api/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    backend: selectedBackend,
                    model: selectedModel
                })
            });
            
            const data = await response.json();
            
            if (data.sessionId) {
                this.sessionId = data.sessionId;
                this.backend = data.backend;
                this.model = data.model;
                this.backendInfoEl.textContent = `${this.backend}${this.model ? ': ' + this.model : ''}`;
                this.messageInput.disabled = false;
                this.sendBtn.disabled = false;
                this.messagesEl.innerHTML = '';
                this.addSystemMessage(`Session created with ${this.backend}${this.model ? ' (' + this.model + ')' : ''}`);
                this.hideBackendModal();
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
        
        // Add user message
        this.addMessage('user', message);
        this.messageInput.value = '';
        this.messageInput.style.height = 'auto';
        
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
            const response = await fetch(`/api/chat/${this.sessionId}`, {
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
            this.currentMessageEl = null;
            this.currentContent = '';
            this.updateUIState();
        }
    }
    
    handleStreamData(data) {
        switch (data.type) {
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
                // Generation finished
                break;
            case 'done':
                // Stream complete
                break;
        }
    }
    
    async abortGeneration() {
        if (!this.sessionId || !this.isGenerating) return;
        
        try {
            await fetch(`/api/chat/${this.sessionId}/abort`, {
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
    
    scrollToBottom() {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new RXCafeChat();
});
