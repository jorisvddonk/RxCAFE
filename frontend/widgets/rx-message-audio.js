import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';
import { BinaryRefMixin, formatByteSize } from './binary-ref-mixin.js';

export class RxMessageAudio extends BinaryRefMixin(LitElement) {
  static properties = {
    ...LitElement.properties,
    role: { type: String, reflect: true },
    src: { type: String },
    description: { type: String },
  };

  static styles = css`
    :host {
      display: block;
    }
    
    :host([role="user"]) {
      align-self: flex-end;
    }
    
    :host([role="assistant"]) {
      align-self: flex-start;
    }
    
    .message {
      max-width: 80%;
      padding: 0.5rem;
      border-radius: 1rem;
      animation: fadeIn 0.2s ease-out;
    }
    
    @keyframes fadeIn { 
      from { opacity: 0; transform: translateY(10px); } 
      to { opacity: 1; transform: translateY(0); } 
    }
    
    .message.user { 
      align-self: flex-end; 
      background-color: var(--user-bubble, #3b82f6); 
      color: var(--user-text, white); 
      border-bottom-right-radius: 0.25rem; 
    }
    
    .message.assistant { 
      align-self: flex-start; 
      background-color: var(--assistant-bubble, #f3f4f6); 
      color: var(--assistant-text, #1f2937); 
      border-bottom-left-radius: 0.25rem; 
    }
    
    .message-content {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      white-space: pre-wrap;
      word-wrap: break-word;
      line-height: 1.5;
    }
    
    audio {
      max-width: 100%;
      border-radius: 0.5rem;
      display: block;
      min-height: 40px;
    }
    
    .description {
      font-size: 0.875rem;
      opacity: 0.8;
    }

    .placeholder,
    .loading-state,
    .prompted-state,
    .error-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 1rem;
      min-width: 120px;
      min-height: 80px;
      border-radius: 0.5rem;
      background: rgba(0,0,0,0.06);
      font-size: 0.875rem;
      text-align: center;
    }

    .placeholder-icon {
      font-size: 2rem;
      line-height: 1;
    }

    .placeholder-text {
      opacity: 0.6;
    }

    .prompted-state button,
    .error-state button {
      margin-top: 0.25rem;
      padding: 0.3rem 0.75rem;
      border: none;
      border-radius: 0.4rem;
      background: var(--user-bubble, #3b82f6);
      color: white;
      cursor: pointer;
      font-size: 0.8rem;
    }

    .prompted-state button:hover,
    .error-state button:hover {
      opacity: 0.85;
    }

    .meta {
      opacity: 0.7;
      font-size: 0.8rem;
    }
  `;

  constructor() {
    super();
    this.role = 'assistant';
    this.src = '';
    this.description = '';
  }

  _onBinaryLoaded(url, _mimeType) {
    this.src = url;
  }

  render() {
    return html`
      <div class="message ${this.role}" data-chunk-id=${this.chunkId}>
        <div class="message-content">
          ${this._renderContent()}
          ${this.description ? html`<div class="description">${this.description}</div>` : ''}
        </div>
      </div>
    `;
  }

  _renderContent() {
    switch (this._loadState) {
      case 'placeholder':
        return html`
          <div class="placeholder">
            <span class="placeholder-icon">🎵</span>
            <span class="placeholder-text">Loading…</span>
          </div>
        `;
      case 'loading':
        return html`
          <div class="loading-state">
            <span class="placeholder-icon">🎵</span>
            <span class="placeholder-text">Loading audio…</span>
          </div>
        `;
      case 'prompted':
        return html`
          <div class="prompted-state">
            <span class="placeholder-icon">🎵</span>
            <div>Audio</div>
            <div class="meta">${this.mimeType} · ${formatByteSize(this.byteSize)}</div>
            <button @click=${() => { this._loadState = 'loading'; this._fetchBinary(); }}>
              Download
            </button>
          </div>
        `;
      case 'error':
        return html`
          <div class="error-state">
            <span class="placeholder-icon">⚠️</span>
            <div>Failed to load audio</div>
            <button @click=${() => this._retryFetch()}>Retry</button>
          </div>
        `;
      default: // 'rendered'
        return html`<audio src=${this.src} controls></audio>`;
    }
  }
}

customElements.define('rx-message-audio', RxMessageAudio);
