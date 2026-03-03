import { LitElement, html, css } from 'lit';
import { classMap } from 'lit/directives/class-map.js';

/**
 * DiceRoller - A Lit-based web component for rolling dice
 * 
 * This component is self-contained and communicates via events:
 * - 'dice-roll' - Dispatched when user wants to roll dice
 * - 'dice-toggle-llm' - Dispatched when LLM comments toggle changes
 * - 'dice-clear' - Dispatched when history is cleared
 * - 'dice-switch-ui' - Dispatched when user wants to switch UI mode
 * 
 * It accepts chunks via the handleChunk() method or 'chunk-received' event.
 */
export class DiceRoller extends LitElement {
  static properties = {
    sessionId: { type: String },
    token: { type: String },
    apiBaseUrl: { type: String, attribute: 'api-base-url' },
    _selectedDice: { state: true },
    _modifier: { state: true },
    _llmComments: { state: true },
    _rollHistory: { state: true },
    _isRolling: { state: true },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--dice-bg, linear-gradient(135deg, #1a1a2e 0%, #16213e 100%));
      color: var(--dice-text, #fff);
      font-family: system-ui, -apple-system, sans-serif;
      overflow: hidden;
    }

    .dice-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 24px;
      background: rgba(0, 0, 0, 0.3);
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }

    .dice-header h2 {
      margin: 0;
      font-size: 1.5rem;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .dice-icon {
      font-size: 1.8rem;
    }

    .switch-btn {
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: inherit;
      padding: 8px 16px;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .switch-btn:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    .dice-selection-area {
      padding: 20px;
      background: rgba(0, 0, 0, 0.2);
    }

    .selection-display {
      text-align: center;
      margin-bottom: 16px;
    }

    .selection-text {
      font-size: 2rem;
      font-weight: bold;
      font-family: 'Courier New', monospace;
      padding: 16px 32px;
      background: rgba(0, 0, 0, 0.4);
      border-radius: 12px;
      display: inline-block;
      min-width: 200px;
      transition: all 0.3s;
    }

    .selection-text.empty {
      opacity: 0.5;
      font-size: 1.2rem;
    }

    .dice-buttons {
      display: flex;
      justify-content: center;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }

    .dice-btn {
      width: 60px;
      height: 60px;
      border: none;
      border-radius: 12px;
      font-size: 1rem;
      font-weight: bold;
      cursor: pointer;
      transition: all 0.2s;
      position: relative;
      overflow: hidden;
    }

    .dice-btn::before {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(135deg, rgba(255,255,255,0.3) 0%, transparent 50%);
    }

    .dice-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.3);
    }

    .dice-btn:active {
      transform: translateY(0);
    }

    .dice-btn.d4 { background: linear-gradient(135deg, #ff6b6b, #ee5a5a); }
    .dice-btn.d6 { background: linear-gradient(135deg, #4ecdc4, #44b3ab); }
    .dice-btn.d8 { background: linear-gradient(135deg, #ffe66d, #e6cf62); color: #333; }
    .dice-btn.d10 { background: linear-gradient(135deg, #a8e6cf, #8fd4b3); color: #333; }
    .dice-btn.d12 { background: linear-gradient(135deg, #c7ceea, #b0b7d4); color: #333; }
    .dice-btn.d20 { background: linear-gradient(135deg, #ffd93d, #e6c437); color: #333; }
    .dice-btn.d100 { background: linear-gradient(135deg, #ff8b94, #e6737c); }

    .modifier-buttons {
      display: flex;
      justify-content: center;
      gap: 12px;
      margin-bottom: 16px;
    }

    .mod-btn, .clear-btn {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      font-weight: bold;
      cursor: pointer;
      transition: all 0.2s;
    }

    .mod-btn.plus {
      background: linear-gradient(135deg, #4ecdc4, #44b3ab);
    }

    .mod-btn.minus {
      background: linear-gradient(135deg, #ff6b6b, #ee5a5a);
    }

    .clear-btn {
      background: rgba(255, 255, 255, 0.1);
      color: inherit;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }

    .roll-container {
      display: flex;
      justify-content: center;
      margin: 16px 0;
    }

    .roll-btn {
      padding: 16px 48px;
      font-size: 1.5rem;
      font-weight: bold;
      border: none;
      border-radius: 12px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      cursor: pointer;
      transition: all 0.3s;
      text-transform: uppercase;
      letter-spacing: 2px;
    }

    .roll-btn:hover:not(:disabled) {
      transform: scale(1.05);
      box-shadow: 0 10px 30px rgba(102, 126, 234, 0.4);
    }

    .roll-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .dice-actions {
      display: flex;
      justify-content: center;
      gap: 12px;
      margin-top: 16px;
    }

    .toggle-btn {
      padding: 8px 16px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(255, 255, 255, 0.1);
      color: inherit;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .toggle-btn.active {
      background: rgba(78, 205, 196, 0.3);
      border-color: rgba(78, 205, 196, 0.5);
    }

    .dice-history {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .empty-state {
      text-align: center;
      padding: 40px;
      opacity: 0.6;
    }

    .empty-icon {
      font-size: 4rem;
      margin-bottom: 16px;
    }

    .roll-card {
      background: rgba(0, 0, 0, 0.3);
      border-radius: 12px;
      padding: 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      animation: slideIn 0.3s ease;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .roll-card.critical {
      border-color: #ffd93d;
      box-shadow: 0 0 20px rgba(255, 217, 61, 0.3);
    }

    .roll-card.failure {
      border-color: #ff6b6b;
      box-shadow: 0 0 20px rgba(255, 107, 107, 0.3);
    }

    .roll-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .roll-notation {
      font-weight: bold;
      font-size: 1.1rem;
    }

    .roll-badge {
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 0.75rem;
      font-weight: bold;
      text-transform: uppercase;
    }

    .roll-badge.critical {
      background: #ffd93d;
      color: #333;
    }

    .roll-badge.failure {
      background: #ff6b6b;
      color: white;
    }

    .dice-faces {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }

    .dice-face {
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      font-weight: bold;
      font-size: 1rem;
    }

    .dice-face.d4 { background: linear-gradient(135deg, #ff6b6b, #ee5a5a); }
    .dice-face.d6 { background: linear-gradient(135deg, #4ecdc4, #44b3ab); }
    .dice-face.d8 { background: linear-gradient(135deg, #ffe66d, #e6cf62); color: #333; }
    .dice-face.d10 { background: linear-gradient(135deg, #a8e6cf, #8fd4b3); color: #333; }
    .dice-face.d12 { background: linear-gradient(135deg, #c7ceea, #b0b7d4); color: #333; }
    .dice-face.d20 { background: linear-gradient(135deg, #ffd93d, #e6c437); color: #333; }
    .dice-face.d100 { background: linear-gradient(135deg, #ff8b94, #e6737c); }

    .roll-total {
      font-size: 2.5rem;
      font-weight: bold;
      text-align: center;
      margin: 12px 0;
    }

    .roll-breakdown {
      text-align: center;
      opacity: 0.7;
      font-size: 0.9rem;
    }

    .roll-comment {
      margin-top: 12px;
      padding: 12px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 8px;
      font-style: italic;
      border-left: 3px solid rgba(78, 205, 196, 0.5);
    }

  `;

  constructor() {
    super();
    this.sessionId = '';
    this.token = '';
    this.apiBaseUrl = window.location.origin;
    this._selectedDice = [];
    this._modifier = 0;
    this._llmComments = true;
    this._rollHistory = [];
    this._isRolling = false;
    this._diceSides = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];
    this._rollTimeout = null;
  }

  connectedCallback() {
    super.connectedCallback();
    // Listen for chunk events from parent
    this.addEventListener('chunk-received', this._onChunkReceived);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('chunk-received', this._onChunkReceived);
  }

  _onChunkReceived(e) {
    if (e.detail) {
      this.handleChunk(e.detail);
    }
  }

  _apiUrl(path) {
    const url = new URL(path, this.apiBaseUrl);
    if (this.token) url.searchParams.set('token', this.token);
    return url.toString();
  }

  _addDice(sides) {
    this._selectedDice = [...this._selectedDice, sides];
  }

  _addModifier(value) {
    this._modifier += value;
  }

  _clearSelection() {
    this._selectedDice = [];
    this._modifier = 0;
  }

  _buildNotation() {
    if (this._selectedDice.length === 0) return null;

    const counts = {};
    for (const d of this._selectedDice) {
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
    if (this._modifier !== 0) {
      notation += this._modifier > 0 ? `+${this._modifier}` : `${this._modifier}`;
    }

    return notation;
  }

  async _roll() {
    const notation = this._buildNotation();
    if (!notation || !this.sessionId) return;

    // Clear any existing timeout
    if (this._rollTimeout) {
      clearTimeout(this._rollTimeout);
    }

    this._isRolling = true;

    // Safety timeout - reset if no response in 10 seconds
    this._rollTimeout = setTimeout(() => {
      if (this._isRolling) {
        console.log('[DiceRoller] Safety timeout - resetting _isRolling');
        this._isRolling = false;
      }
    }, 10000);

    // Dispatch event for parent to handle or handle internally
    const rollEvent = new CustomEvent('dice-roll', {
      detail: { notation, sessionId: this.sessionId },
      bubbles: true,
      composed: true
    });
    this.dispatchEvent(rollEvent);

    // Also try to send directly as fallback
    try {
      const response = await fetch(this._apiUrl(`/api/chat/${this.sessionId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `!roll ${notation}` })
      });

      if (!response.ok) {
        throw new Error('Failed to roll');
      }
    } catch (error) {
      console.error('Dice roll failed:', error);
      this._isRolling = false;
      if (this._rollTimeout) {
        clearTimeout(this._rollTimeout);
        this._rollTimeout = null;
      }
    }
  }

  _toggleLLM() {
    this._llmComments = !this._llmComments;
    const cmd = this._llmComments ? '!comment on' : '!comment off';

    this.dispatchEvent(new CustomEvent('dice-toggle-llm', {
      detail: { enabled: this._llmComments, command: cmd, sessionId: this.sessionId },
      bubbles: true,
      composed: true
    }));

    // Also send directly
    if (this.sessionId) {
      fetch(this._apiUrl(`/api/chat/${this.sessionId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: cmd })
      });
    }
  }

  _clearHistory() {
    this._rollHistory = [];
    this._chatMessages = [];

    this.dispatchEvent(new CustomEvent('dice-clear', {
      detail: { sessionId: this.sessionId },
      bubbles: true,
      composed: true
    }));

    if (this.sessionId) {
      fetch(this._apiUrl(`/api/chat/${this.sessionId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '!clear' })
      });
    }
  }

  _switchToChat() {
    this.dispatchEvent(new CustomEvent('dice-switch-ui', {
      detail: { mode: 'chat', sessionId: this.sessionId },
      bubbles: true,
      composed: true
    }));
  }

  /**
   * Public method to handle incoming chunks
   * Can be called directly or via 'chunk-received' event
   */
  handleChunk(chunk) {
    if (!chunk) return;

    console.log('[DiceRoller] handleChunk:', chunk.contentType, chunk.annotations);

    // Handle dice roll result chunks
    if (chunk.contentType === 'text' && chunk.annotations?.['dice.rolls']) {
      console.log('[DiceRoller] Got dice roll result, resetting _isRolling');
      this._handleRollChunk(chunk);
      this._isRolling = false;
      if (this._rollTimeout) {
        clearTimeout(this._rollTimeout);
        this._rollTimeout = null;
      }
    } else if (chunk.contentType === 'null') {
      if (chunk.annotations?.['dice.roll']) {
        this._rollHistory = [...this._rollHistory, chunk.annotations['dice.roll']];
      }
      if (chunk.annotations?.['dice.llmComments'] !== undefined) {
        this._llmComments = chunk.annotations['dice.llmComments'];
      }
      if (chunk.annotations?.['dice.clear']) {
        this._rollHistory = [];
      }
    }

    this.requestUpdate();
  }

  _handleRollChunk(chunk) {
    const roll = {
      notation: chunk.annotations['dice.notation'],
      dice: chunk.annotations['dice.rolls'],
      diceTypes: chunk.annotations['dice.diceTypes'] || [],
      modifier: chunk.annotations['dice.modifier'] || 0,
      total: chunk.annotations['dice.total'],
      timestamp: chunk.annotations['dice.timestamp'],
      comment: chunk.annotations['dice.comment']
    };

    this._rollHistory = [...this._rollHistory, roll];
  }

  /**
   * Load history from an array of chunks
   */
  loadHistory(chunks) {
    this._rollHistory = [];
    this._llmComments = true;

    for (const chunk of chunks) {
      this.handleChunk(chunk);
    }
  }

  _getDiceTypeFromNotation(notation) {
    if (notation.includes('d4')) return 'd4';
    if (notation.includes('d8')) return 'd8';
    if (notation.includes('d10')) return 'd10';
    if (notation.includes('d12')) return 'd12';
    if (notation.includes('d20')) return 'd20';
    if (notation.includes('d100')) return 'd100';
    return 'd6';
  }

  render() {
    const notation = this._buildNotation();
    const hasSelection = this._selectedDice.length > 0;

    return html`
      <div class="dice-header">
        <h2><span class="dice-icon">🎲</span> Dice Roller</h2>
        <button class="switch-btn" @click=${this._switchToChat}>Switch to Chat</button>
      </div>

      <div class="dice-selection-area">
        <div class="selection-display">
          <div class="selection-text ${classMap({ empty: !hasSelection })}">
            ${notation || 'Select dice to roll'}
          </div>
        </div>

        <div class="dice-buttons">
          ${this._diceSides.map(sides => html`
            <button class="dice-btn ${sides}" @click=${() => this._addDice(sides)}>
              ${sides}
            </button>
          `)}
        </div>

        <div class="modifier-buttons">
          <button class="mod-btn plus" @click=${() => this._addModifier(5)}>+5</button>
          <button class="mod-btn minus" @click=${() => this._addModifier(-5)}>-5</button>
          <button class="clear-btn" @click=${this._clearSelection}>Clear</button>
        </div>

        <div class="roll-container">
          <button class="roll-btn" ?disabled=${!hasSelection || this._isRolling} @click=${this._roll}>
            ${this._isRolling ? 'Rolling...' : 'ROLL'}
          </button>
        </div>

        <div class="dice-actions">
          <button class="toggle-btn ${classMap({ active: this._llmComments })}" @click=${this._toggleLLM}>
            🤖 ${this._llmComments ? 'On' : 'Off'}
          </button>
          <button class="toggle-btn" @click=${this._clearHistory}>📜 Clear History</button>
        </div>
      </div>

      <div class="dice-history">
        ${this._rollHistory.length === 0 ? html`
          <div class="empty-state">
            <div class="empty-icon">🎲</div>
            <p>No rolls yet. Select dice and roll!</p>
          </div>
        ` : html`
          ${this._rollHistory.slice().reverse().map(roll => this._renderRollCard(roll))}
        `}
      </div>

    `;
  }

  _renderRollCard(roll) {
    const isD20 = roll.notation.includes('d20') && roll.dice.length === 1;
    const isCritical = isD20 && roll.total === 20;
    const isFailure = isD20 && roll.total === 1;
    const diceSum = roll.dice.reduce((a, b) => a + b, 0);
    const breakdown = roll.modifier !== 0
      ? `${diceSum} ${roll.modifier > 0 ? '+' : ''}${roll.modifier} = ${roll.total}`
      : `${diceSum} = ${roll.total}`;

    // Use diceTypes if available, otherwise fall back to deriving from notation
    const diceTypes = roll.diceTypes && roll.diceTypes.length === roll.dice.length
      ? roll.diceTypes
      : roll.dice.map(() => this._getDiceTypeFromNotation(roll.notation));

    return html`
      <div class="roll-card ${classMap({ critical: isCritical, failure: isFailure })}">
        <div class="roll-header">
          <span class="roll-notation">🎲 ${roll.notation}</span>
          ${isCritical ? html`<span class="roll-badge critical">CRITICAL!</span>` : ''}
          ${isFailure ? html`<span class="roll-badge failure">FAILURE</span>` : ''}
        </div>
        <div class="dice-faces">
          ${roll.dice.map((d, i) => html`
            <div class="dice-face ${diceTypes[i]}">${d}</div>
          `)}
        </div>
        <div class="roll-total">${roll.total}</div>
        <div class="roll-breakdown">${breakdown}</div>
        ${roll.comment ? html`<div class="roll-comment">${roll.comment}</div>` : ''}
      </div>
    `;
  }
}

customElements.define('dice-roller', DiceRoller);
