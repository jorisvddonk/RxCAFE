import { escapeHtml } from './dom-utils.js';

export class UIManager {
    constructor(chat) {
        this.chat = chat;
    }

    cacheElements() {
        this.chat.backendInfoEl = document.getElementById('backend-info');
        this.chat.newSessionBtn = document.getElementById('new-session-btn');
        this.chat.messagesEl = document.getElementById('messages');
        this.chat.messageInput = document.getElementById('message-input');
        this.chat.sendBtn = document.getElementById('send-btn');
        this.chat.abortBtn = document.getElementById('abort-btn');
        this.chat.microphoneBtn = document.getElementById('microphone-btn');
        
        this.chat.wizardModal = document.getElementById('wizard-modal');
        this.chat.sessionWizard = document.getElementById('session-wizard');
        
        this.chat.backendModal = document.getElementById('backend-modal');
        this.chat.createSessionBtn = document.getElementById('create-session-btn');
        this.chat.cancelBtn = document.getElementById('cancel-btn');
        this.chat.backendRadios = document.querySelectorAll('input[name="backend"]');
        this.chat.ollamaModelSection = document.getElementById('ollama-model-section');
        this.chat.ollamaModelSelect = document.getElementById('ollama-model');
        
        this.chat.agentSelect = document.getElementById('agent-select');
        this.chat.agentDescription = document.getElementById('agent-description');
        
        this.chat.temperatureInput = document.getElementById('temperature');
        this.chat.maxTokensInput = document.getElementById('max-tokens');
        this.chat.systemPromptInput = document.getElementById('system-prompt');
        
        this.chat.contextMenu = document.getElementById('context-menu');
        this.chat.contextTrust = document.getElementById('context-trust');
        this.chat.contextUntrust = document.getElementById('context-untrust');
        this.chat.contextCopy = document.getElementById('context-copy');
        
        this.chat.inspectorPanel = document.getElementById('inspector-panel');
        this.chat.inspectorOverlay = document.getElementById('inspector-overlay');
        this.chat.inspectorToggleBtn = document.getElementById('inspector-toggle-btn');
        this.chat.inspectorCloseBtn = document.getElementById('inspector-close-btn');
        this.chat.inspectorSession = document.getElementById('inspector-session');
        this.chat.inspectorChunkCount = document.getElementById('inspector-chunk-count');
        this.chat.inspectorChunks = document.getElementById('inspector-chunks');

        this.chat.sessionsModal = document.getElementById('sessions-modal');
        this.chat.sessionList = document.getElementById('session-list');
        this.chat.manageSessionsBtn = document.getElementById('manage-sessions-btn');
        this.chat.sessionsCloseBtn = document.getElementById('sessions-close-btn');

        this.chat.sessionsSidebar = document.getElementById('sessions-sidebar');
        this.chat.sessionsSidebarOverlay = document.getElementById('sessions-sidebar-overlay');
        this.chat.sessionsSidebarToggleBtn = document.getElementById('sessions-sidebar-toggle-btn');
        this.chat.sessionsSidebarCloseBtn = document.getElementById('sessions-sidebar-close-btn');
        this.chat.sidebarSessionList = document.getElementById('sidebar-session-list');
        this.chat.sidebarNewSessionBtn = document.getElementById('sidebar-new-session-btn');

        this.chat.sidebarThemeToggleBtn = document.getElementById('sidebar-theme-toggle-btn');
        this.chat.sidebarManageSessionsBtn = document.getElementById('sidebar-manage-sessions-btn');

        this.chat.sidebarMenu = document.getElementById('sidebar-menu');
        this.chat.sidebarMenuRename = document.getElementById('sidebar-menu-rename');
        this.chat.sidebarMenuDelete = document.getElementById('sidebar-menu-delete');
        this.chat.sidebarMenuSessionId = null;
    }

    bindEvents() {
        this.chat.newSessionBtn?.addEventListener('click', () => this.chat.uiManager.showWizardModal());
        
        if (this.chat.createSessionBtn) {
            this.chat.createSessionBtn.addEventListener('click', () => this.chat.createSession());
        }
        if (this.chat.cancelBtn) {
            this.chat.cancelBtn.addEventListener('click', () => this.chat.hideWizardModal());
        }
        
        this.chat.sendBtn?.addEventListener('click', () => this.chat.sendMessage());
        this.chat.abortBtn?.addEventListener('click', () => this.chat.abortGeneration());
        this.chat.microphoneBtn?.addEventListener('click', () => this.chat.toggleRecording());
        
        this.chat.messageInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.chat.sendMessage();
            }
        });
        
        this.chat.contextTrust?.addEventListener('click', () => this.chat.toggleTrust(true));
        this.chat.contextUntrust?.addEventListener('click', () => this.chat.toggleTrust(false));
        this.chat.contextCopy?.addEventListener('click', () => this.chat.copyChunkContent());
        
        this.chat.inspectorToggleBtn?.addEventListener('click', () => this.toggleInspector());
        this.chat.inspectorCloseBtn?.addEventListener('click', () => this.hideInspector());
        if (this.chat.inspectorOverlay) {
            this.chat.inspectorOverlay.addEventListener('click', () => this.hideInspector());
        }

        this.chat.manageSessionsBtn?.addEventListener('click', () => this.showSessionsModal());
        this.chat.sessionsCloseBtn?.addEventListener('click', () => this.hideSessionsModal());

        this.chat.sessionsSidebarToggleBtn?.addEventListener('click', () => this.toggleSessionsSidebar());
        this.chat.sessionsSidebarCloseBtn?.addEventListener('click', () => this.hideSessionsSidebar());
        if (this.chat.sessionsSidebarOverlay) {
            this.chat.sessionsSidebarOverlay.addEventListener('click', () => this.hideSessionsSidebar());
        }
        this.chat.sidebarNewSessionBtn?.addEventListener('click', () => {
            this.hideSessionsSidebar();
            this.chat.uiManager.showWizardModal();
        });

        if (this.chat.sidebarThemeToggleBtn) {
            this.chat.sidebarThemeToggleBtn.addEventListener('click', () => this.chat.themeManager.toggleTheme());
        }
        if (this.chat.sidebarManageSessionsBtn) {
            this.chat.sidebarManageSessionsBtn.addEventListener('click', () => {
                this.hideSessionsSidebar();
                this.showSessionsModal();
            });
        }

        this.chat.sidebarMenuRename.addEventListener('click', () => this.chat.renameSessionFromMenu());
        this.chat.sidebarMenuDelete.addEventListener('click', () => this.chat.deleteSessionFromMenu());
        
        document.addEventListener('click', (e) => {
            if (this.chat.sidebarMenu.style.display === 'block' && !e.target.closest('.sidebar-session-more-btn') && !this.chat.sidebarMenu.contains(e.target)) {
                this.hideSidebarMenu();
            }
        });

        if (window.innerWidth > 800) {
            this.showSessionsSidebar();
        }
    }

    updateUIState() {
        this.chat.sendBtn.style.display = this.chat.inputBlocked ? 'none' : 'block';
        this.chat.sendBtn.disabled = !this.chat.sessionId;
        this.chat.abortBtn.style.display = this.chat.inputBlocked ? 'block' : 'none';
        this.chat.abortBtn.textContent = this.chat.thinking ? 'Thinking...' : 'Stop';
        this.chat.messageInput.disabled = this.chat.isRecording;
        if (this.chat.copySessionIdBtn) {
            this.chat.copySessionIdBtn.style.display = this.chat.sessionId ? 'inline-block' : 'none';
        }
        this.chat.microphoneBtn.disabled = !this.chat.sessionId || this.chat.inputBlocked;
        
        this.chat.messagesManager?.updateQuickResponsesState();
        
        if (this.chat.isRecording) {
            this.chat.microphoneBtn.textContent = '⏹️';
            this.chat.microphoneBtn.className = 'btn btn-danger';
            this.chat.microphoneBtn.title = 'Stop recording';
        } else {
            this.chat.microphoneBtn.textContent = '🎤';
            this.chat.microphoneBtn.className = 'btn btn-secondary';
            this.chat.microphoneBtn.title = 'Record audio';
        }
    }

    updateHeaderInfo() {
        const session = this.chat.knownSessions.find(s => s.id === this.chat.sessionId);
        const info = [];
        info.push(session?.displayName || this.chat.agentName || 'unknown');
        if (this.chat.backend) info.push(this.chat.backend);
        if (this.chat.model) info.push(this.chat.model);
        if (this.chat.isBackground) info.push('[background]');
        this.chat.backendInfoEl.textContent = info.join(' | ');
    }

    toggleInspector() {
        if (this.chat.inspectorPanel.classList.contains('visible')) {
            this.hideInspector();
        } else {
            this.showInspector();
        }
    }

    showInspector() {
        this.chat.inspectorVisible = true;
        this.chat.inspectorPanel.style.display = 'flex';
        setTimeout(() => {
            this.chat.inspectorPanel.classList.add('visible');
        }, 10);
        if (window.innerWidth <= 800 && this.chat.inspectorOverlay) {
            this.chat.inspectorOverlay.style.display = 'block';
        }
        this.chat.updateInspector();
    }

    hideInspector() {
        this.chat.inspectorVisible = false;
        this.chat.inspectorPanel.classList.remove('visible');
        if (window.innerWidth <= 800) {
            if (this.chat.inspectorOverlay) {
                this.chat.inspectorOverlay.style.display = 'none';
            }
            setTimeout(() => {
                if (!this.chat.inspectorPanel.classList.contains('visible')) {
                    this.chat.inspectorPanel.style.display = 'none';
                }
            }, 300);
        }
    }

    async showSessionsModal() {
        this.chat.sessionsModal.style.display = 'flex';
        await this.chat.sessionsManager.loadSessions();
        this.renderSessionList();
    }

    hideSessionsModal() {
        this.chat.sessionsModal.style.display = 'none';
    }

    toggleSessionsSidebar() {
        if (this.chat.sessionsSidebar.classList.contains('visible')) {
            this.hideSessionsSidebar();
        } else {
            this.showSessionsSidebar();
        }
    }

    showSessionsSidebar() {
        this.chat.sessionsSidebar.style.display = 'flex';
        setTimeout(() => {
            this.chat.sessionsSidebar.classList.add('visible');
        }, 10);

        if (window.innerWidth <= 800 && this.chat.sessionsSidebarOverlay) {
            this.chat.sessionsSidebarOverlay.style.display = 'block';
        }
        this.chat.renderSidebarSessionList();
    }

    hideSessionsSidebar() {
        this.chat.sessionsSidebar.classList.remove('visible');
        
        if (window.innerWidth <= 800) {
            if (this.chat.sessionsSidebarOverlay) {
                this.chat.sessionsSidebarOverlay.style.display = 'none';
            }
            setTimeout(() => {
                if (!this.chat.sessionsSidebar.classList.contains('visible')) {
                    this.chat.sessionsSidebar.style.display = 'none';
                }
            }, 300);
        }
    }

    showSidebarMenu(e, sessionId) {
        e.stopPropagation();
        this.chat.sidebarMenuSessionId = sessionId;
        this.chat.sidebarMenu.style.display = 'block';
        
        const rect = e.target.getBoundingClientRect();
        const menuWidth = 140;
        let left = rect.right - menuWidth;
        if (left < 10) left = 10;
        
        this.chat.sidebarMenu.style.left = `${left}px`;
        this.chat.sidebarMenu.style.top = `${rect.bottom + window.scrollY}px`;
    }

    hideSidebarMenu() {
        this.chat.sidebarMenu.style.display = 'none';
        this.chat.sidebarMenuSessionId = null;
    }

    renderSidebarSessionList() {
        if (this.chat.knownSessions.length === 0) {
            this.chat.sidebarSessionList.innerHTML = '<p>No sessions found.</p>';
            return;
        }

        this.chat.sidebarSessionList.innerHTML = this.chat.knownSessions.map(s => {
            const isCurrent = s.id === this.chat.sessionId;
            const displayName = s.displayName || s.agentName;
            const shortId = s.id.length > 20 ? '...' + s.id.slice(-6) : s.id;
            const messageCount = s.messageCount || 0;
            const newMessageCount = s.newMessageCount || 0;

            let badgeHtml = '';
            if (messageCount > 0) {
                if (newMessageCount > 0) {
                    const readCount = messageCount - newMessageCount;
                    badgeHtml = `<span class="sidebar-session-badge-new">${readCount}+${newMessageCount}</span>`;
                } else {
                    badgeHtml = `<span class="sidebar-session-badge">${messageCount}</span>`;
                }
            }

            return `
                <div class="sidebar-session-item ${isCurrent ? 'active' : ''}" onclick="chat.switchToSessionFromSidebar('${s.id}')">
                    <div class="sidebar-session-info">
                        <div class="sidebar-session-name">${displayName}${s.isBackground ? ' [bg]' : ''}</div>
                        <div class="sidebar-session-meta">${s.agentName} • ${shortId}</div>
                    </div>
                    <div class="sidebar-session-right">
                        ${badgeHtml}
                        <button class="sidebar-session-more-btn" onclick="chat.showSidebarMenu(event, '${s.id}')">⋮</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    renderSessionList() {
        if (this.chat.knownSessions.length === 0) {
            this.chat.sessionList.innerHTML = '<p>No sessions found.</p>';
            return;
        }

        this.chat.sessionList.innerHTML = this.chat.knownSessions.map(s => {
            const isCurrent = s.id === this.chat.sessionId;
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

    updateInspector() {
        this.chat.inspectorSession.textContent = JSON.stringify({
            sessionId: this.chat.sessionId,
            agentName: this.chat.agentName,
            backend: this.chat.backend,
            model: this.chat.model,
            isBackground: this.chat.isBackground
        }, null, 2);
        
        this.chat.inspectorChunkCount.textContent = this.chat.rawChunks.length;
        
        this.chat.inspectorChunks.innerHTML = this.chat.rawChunks.map(chunk => {
            const role = this.getChunkRole(chunk);
            const trustStatus = chunk.annotations?.['security.trust-level']?.trusted;
            const roleClass = trustStatus !== undefined 
                ? (trustStatus ? 'trusted' : 'untrusted')
                : role;
            
            if (!chunk || !chunk.id) {
                console.warn('[UI] Skipping invalid chunk in inspector:', chunk);
                return '';
            }
            return `
                <div class="inspector-chunk" data-chunk-id="${chunk.id}">
                    <div class="inspector-chunk-header" onclick="this.parentElement.classList.toggle('expanded')">
                        <span class="inspector-chunk-id">${chunk.id.split('-').slice(-2).join('-')}</span>
                        <span class="inspector-chunk-role ${roleClass}">${role}</span>
                        <button class="inspector-chunk-delete-btn" onclick="event.stopPropagation(); chat.deleteChunkFromInspector('${chunk.id}', event)" title="Delete chunk">×</button>
                    </div>
                    <div class="inspector-chunk-body">
                        <pre>${escapeHtml(JSON.stringify(chunk, null, 2))}</pre>
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
        if (!chunk.producer) return 'unknown';
        if (chunk.producer.includes('kobold') || chunk.producer.includes('ollama') || chunk.producer === 'com.rxcafe.assistant') return 'assistant';
        return chunk.producer.split('.').pop();
    }

    showContextMenu(e, chunkId) {
        e.preventDefault();
        
        const chunkEl = this.chat.chunkElements.get(chunkId);
        if (chunkEl) {
            const isTrusted = chunkEl.classList.contains('trusted');
            this.chat.contextTrust.style.display = isTrusted ? 'none' : 'block';
            this.chat.contextUntrust.style.display = isTrusted ? 'block' : 'none';
        }
        
        this.chat.contextMenu.style.display = 'block';
        this.chat.contextMenu.style.left = `${e.pageX}px`;
        this.chat.contextMenu.style.top = `${e.pageY}px`;
    }

    hideContextMenu() {
        this.chat.contextMenu.style.display = 'none';
        this.chat.contextMenuChunkId = null;
    }

    copySessionId() {
        if (!this.chat.sessionId || !this.chat.copySessionIdBtn) return;
        navigator.clipboard.writeText(this.chat.sessionId).then(() => {
            const originalText = this.chat.copySessionIdBtn.textContent;
            this.chat.copySessionIdBtn.textContent = '✅';
            setTimeout(() => {
                this.chat.copySessionIdBtn.textContent = originalText;
            }, 2000);
        });
    }

    async showWizardModal() {
        if (!this.chat.wizardModal || !this.chat.sessionWizard) {
            this.chat.showBackendModal();
            return;
        }
        
        this.chat.wizardModal.style.display = 'flex';
        
        await this.chat.sessionsManager.loadAgents();
        
        // Load presets
        let presets = [];
        try {
            const url = new URL('/api/presets', window.location.origin);
            if (this.chat.token) url.searchParams.set('token', this.chat.token);
            const response = await fetch(url.toString());
            const data = await response.json();
            presets = data.presets || [];
        } catch (err) {
            console.error('Failed to load presets:', err);
        }
        
        if (this.chat.sessionWizard.reset) {
            this.chat.sessionWizard.reset();
        }
        
        this.chat.sessionWizard.agents = this.chat.agents;
        this.chat.sessionWizard.presets = presets;
        this.chat.sessionWizard.apiUrl = window.location.origin;
        
        this.chat.sessionWizard.addEventListener('afe-wizard-complete', (e) => this.handleWizardComplete(e));
        this.chat.sessionWizard.addEventListener('afe-wizard-close', () => this.hideWizardModal());
        this.chat.sessionWizard.addEventListener('afe-wizard-preset-created', async () => {
            // Reload presets
            try {
                const url = new URL('/api/presets', window.location.origin);
                if (this.chat.token) url.searchParams.set('token', this.chat.token);
                const response = await fetch(url.toString());
                const data = await response.json();
                this.chat.sessionWizard.presets = data.presets || [];
            } catch (err) {
                console.error('Failed to reload presets:', err);
            }
        });
    }

    hideWizardModal() {
        if (this.chat.wizardModal) {
            this.chat.wizardModal.style.display = 'none';
        }
    }

    async handleWizardComplete(e) {
        const { agentId, config } = e.detail;
        this.hideWizardModal();
        await this.chat.sessionsManager.createSession(agentId, config);
        
        if (this.chat.sessionWizard.reset) {
            this.chat.sessionWizard.reset();
        }
    }
}
