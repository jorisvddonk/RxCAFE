/**
 * Dice UI Controller
 * Manages the dice roller UI, handles dice selection and rolling
 */

class DiceUIController {
  constructor(chat) {
    this.chat = chat;
    this.sessionId = null;
    this.selectedDice = [];
    this.modifier = 0;
    this.llmComments = true;
    this.rollHistory = [];
    this.eventSource = null;
    
    this.diceSides = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];
  }
  
  init(sessionId) {
    this.sessionId = sessionId;
    this.bindElements();
    this.bindEvents();
    this.loadHistory();
    this.connectStream();
    this.updateSelectionDisplay();
  }
  
  destroy() {
    this.disconnectStream();
  }
  
  bindElements() {
    this.diceView = document.getElementById('dice-view');
    this.selectionDisplay = document.getElementById('dice-selection');
    this.rollBtn = document.getElementById('dice-roll-btn');
    this.clearBtn = document.getElementById('dice-clear-btn');
    this.llmToggle = document.getElementById('dice-llm-toggle');
    this.historyContainer = document.getElementById('dice-history');
    this.chatMessagesContainer = document.getElementById('dice-chat-messages');
    this.switchBtn = document.getElementById('dice-switch-chat');
  }
  
  bindEvents() {
    this.diceSides.forEach(sides => {
      const btn = document.getElementById(`dice-btn-${sides}`);
      if (btn) {
        btn.addEventListener('click', () => this.addDice(sides));
      }
    });
    
    const modPlus = document.getElementById('dice-mod-plus');
    const modMinus = document.getElementById('dice-mod-minus');
    
    if (modPlus) modPlus.addEventListener('click', () => this.addModifier(5));
    if (modMinus) modMinus.addEventListener('click', () => this.addModifier(-5));
    
    this.rollBtn?.addEventListener('click', () => this.roll());
    this.clearBtn?.addEventListener('click', () => this.clearSelection());
    this.llmToggle?.addEventListener('click', () => this.toggleLLM());
    this.switchBtn?.addEventListener('click', () => this.switchToChat());
  }
  
  getToken() {
    if (window.RXCAFE_TOKEN) return window.RXCAFE_TOKEN;
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('token');
  }
  
  apiUrl(path) {
    const token = this.getToken();
    const url = new URL(path, window.location.origin);
    if (token) url.searchParams.set('token', token);
    return url.toString();
  }
  
  addDice(sides) {
    this.selectedDice.push(sides);
    this.updateSelectionDisplay();
  }
  
  addModifier(value) {
    this.modifier += value;
    this.updateSelectionDisplay();
  }
  
  clearSelection() {
    this.selectedDice = [];
    this.modifier = 0;
    this.updateSelectionDisplay();
  }
  
  buildNotation() {
    if (this.selectedDice.length === 0) return null;
    
    const counts = {};
    for (const d of this.selectedDice) {
      counts[d] = (counts[d] || 0) + 1;
    }
    
    const parts = [];
    for (const [sides, count] of Object.entries(counts)) {
      if (count === 1) {
        parts.push(sides);
      } else {
        parts.push(`${count}${sides}`);
      }
    }
    
    let notation = parts.join('+');
    if (this.modifier !== 0) {
      notation += this.modifier > 0 ? `+${this.modifier}` : `${this.modifier}`;
    }
    
    return notation;
  }
  
  updateSelectionDisplay() {
    const notation = this.buildNotation();
    
    if (!notation) {
      this.selectionDisplay.textContent = 'Select dice to roll';
      this.selectionDisplay.classList.add('empty');
      this.rollBtn.disabled = true;
    } else {
      this.selectionDisplay.textContent = notation;
      this.selectionDisplay.classList.remove('empty');
      this.rollBtn.disabled = false;
    }
  }
  
  async roll() {
    const notation = this.buildNotation();
    if (!notation || !this.sessionId) return;
    
    this.rollBtn.disabled = true;
    this.rollBtn.textContent = 'Rolling...';
    this.isRolling = true;
    
    try {
      const response = await fetch(this.apiUrl(`/api/chat/${this.sessionId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `!roll ${notation}` })
      });
      
      if (!response.ok) {
        throw new Error('Failed to roll');
      }
      // Don't reset here - wait for SSE response
    } catch (error) {
      console.error('Dice roll failed:', error);
      this.resetRollButton();
    }
    // Don't reset here - wait for SSE response via handleChunk
  }
  
  resetRollButton() {
    this.isRolling = false;
    this.rollBtn.disabled = false;
    this.rollBtn.textContent = 'ROLL';
  }
  
  toggleLLM() {
    const cmd = this.llmComments ? '!comment off' : '!comment on';
    this.llmComments = !this.llmComments;
    
    this.llmToggle.classList.toggle('active', this.llmComments);
    this.llmToggle.textContent = this.llmComments ? '🤖 On' : '🤖 Off';
    
    if (this.sessionId) {
      fetch(this.apiUrl(`/api/chat/${this.sessionId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: cmd })
      });
    }
  }
  
  clearHistory() {
    if (this.sessionId) {
      fetch(this.apiUrl(`/api/chat/${this.sessionId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '!clear' })
      });
    }
    this.rollHistory = [];
    this.renderHistory();
  }
  
  loadHistory() {
    if (!this.sessionId || !this.chat.rawChunks) return;
    
    this.rollHistory = [];
    this.llmComments = true;
    
    for (const chunk of this.chat.rawChunks) {
      if (chunk.contentType === 'null') {
        if (chunk.annotations['dice.roll']) {
          this.rollHistory.push(chunk.annotations['dice.roll']);
        }
        if (chunk.annotations['dice.llmComments'] !== undefined) {
          this.llmComments = chunk.annotations['dice.llmComments'];
        }
      }
      
      if (chunk.contentType === 'text' && chunk.annotations?.['dice.rolls']) {
        this.renderRollCard(chunk);
      }
    }
    
    if (this.llmToggle) {
      this.llmToggle.classList.toggle('active', this.llmComments);
      this.llmToggle.textContent = this.llmComments ? '🤖 On' : '🤖 Off';
    }
    
    if (this.rollHistory.length === 0) {
      this.renderHistory();
    }
  }
  
  renderHistory() {
    if (!this.historyContainer) return;
    
    if (this.rollHistory.length === 0) {
      this.historyContainer.innerHTML = `
        <div class="dice-empty">
          <div class="dice-empty-icon">🎲</div>
          <p>No rolls yet. Select dice and roll!</p>
        </div>
      `;
      return;
    }
    
    this.historyContainer.innerHTML = '';
    
    for (let i = this.rollHistory.length - 1; i >= 0; i--) {
      const roll = this.rollHistory[i];
      this.createRollCardElement(roll, this.historyContainer);
    }
  }
  
  renderRollCard(chunk) {
    if (!chunk.annotations?.['dice.notation']) return;
    
    const roll = {
      notation: chunk.annotations['dice.notation'],
      dice: chunk.annotations['dice.rolls'],
      modifier: chunk.annotations['dice.modifier'] || 0,
      total: chunk.annotations['dice.total'],
      timestamp: chunk.annotations['dice.timestamp'],
      comment: chunk.annotations['dice.comment']
    };
    
    this.rollHistory.push(roll);
    this.createRollCardElement(roll, this.historyContainer);
  }
  
  createRollCardElement(roll, container) {
    const isD20 = roll.notation.includes('d20') && roll.dice.length === 1;
    const isCritical = isD20 && roll.total === 20;
    const isFailure = isD20 && roll.total === 1;
    
    const card = document.createElement('div');
    card.className = `dice-result-card${isCritical ? ' critical' : ''}${isFailure ? ' failure' : ''}`;
    
    const diceFaces = roll.dice.map(d => {
      let sides = 'd6';
      if (roll.notation.includes('d4')) sides = 'd4';
      else if (roll.notation.includes('d8')) sides = 'd8';
      else if (roll.notation.includes('d10')) sides = 'd10';
      else if (roll.notation.includes('d12')) sides = 'd12';
      else if (roll.notation.includes('d20')) sides = 'd20';
      else if (roll.notation.includes('d100')) sides = 'd100';
      
      return `<div class="dice-face ${sides}">${d}</div>`;
    }).join('');
    
    const diceSum = roll.dice.reduce((a, b) => a + b, 0);
    const breakdown = roll.modifier !== 0 
      ? `${diceSum} ${roll.modifier > 0 ? '+' : ''}${roll.modifier} = ${roll.total}`
      : `${diceSum} = ${roll.total}`;
    
    let badge = '';
    if (isCritical) badge = '<span class="dice-result-badge critical">CRITICAL!</span>';
    else if (isFailure) badge = '<span class="dice-result-badge failure">FAILURE</span>';
    
    card.innerHTML = `
      <div class="dice-result-header">
        <span class="dice-result-notation">🎲 ${roll.notation}</span>
        ${badge}
      </div>
      <div class="dice-faces">${diceFaces}</div>
      <div class="dice-result-total">
        ${roll.total}
        ${roll.modifier !== 0 ? `<span class="modifier">(${roll.modifier > 0 ? '+' : ''}${roll.modifier})</span>` : ''}
      </div>
      <div class="dice-result-breakdown">${breakdown}</div>
      ${roll.comment ? `<div class="dice-result-comment">${roll.comment}</div>` : ''}
    `;
    
    if (container.firstChild && container.firstChild.classList?.contains('dice-empty')) {
      container.innerHTML = '';
    }
    
    container.insertBefore(card, container.firstChild);
  }
  
  addChatMessage(chunk) {
    if (!this.chatMessagesContainer) return;
    
    if (!chunk.annotations?.['chat.role']) return;
    
    const role = chunk.annotations['chat.role'];
    const isDice = chunk.annotations['dice.notation'];
    
    if (isDice) return;
    
    const msgEl = document.createElement('div');
    msgEl.className = `dice-chat-msg ${role}`;
    msgEl.innerHTML = `<span class="role">${role}:</span> ${chunk.content}`;
    
    this.chatMessagesContainer.appendChild(msgEl);
    this.chatMessagesContainer.scrollTop = this.chatMessagesContainer.scrollHeight;
  }
  
  connectStream() {
    // No longer creates its own EventSource - relies on main chat's stream
    // Chunks are passed via handleChunk() from the main streaming manager
  }
  
  handleChunk(chunk) {
    if (!chunk) return;
    
    this.chat.addRawChunk(chunk);
    
    if (chunk.contentType === 'text' && chunk.annotations?.['dice.rolls']) {
      this.renderRollCard(chunk);
      if (this.isRolling) {
        this.resetRollButton();
      }
    } else if (chunk.contentType === 'text' && chunk.annotations?.['chat.role']) {
      this.addChatMessage(chunk);
    } else if (chunk.contentType === 'null') {
      if (chunk.annotations?.['dice.roll']) {
        this.rollHistory.push(chunk.annotations['dice.roll']);
      }
      if (chunk.annotations?.['dice.llmComments'] !== undefined) {
        this.llmComments = chunk.annotations['dice.llmComments'];
        if (this.llmToggle) {
          this.llmToggle.classList.toggle('active', this.llmComments);
          this.llmToggle.textContent = this.llmComments ? '🤖 On' : '🤖 Off';
        }
      }
      if (chunk.annotations?.['dice.clear']) {
        this.rollHistory = [];
        this.renderHistory();
        if (this.chatMessagesContainer) this.chatMessagesContainer.innerHTML = '';
      }
    }
  }
  
  disconnectStream() {
    // No longer manages its own EventSource - just clears state
  }
  
  switchToChat() {
    if (this.chat) {
      this.chat.switchUIMode('chat');
    }
  }
}

window.DiceUIController = DiceUIController;
