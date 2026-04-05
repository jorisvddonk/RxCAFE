import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

export class RxMessageError extends LitElement {
  static properties = {
    message: { type: String },
    backend: { type: String },
    chunkId: { type: String }
  };

  static styles = css`
    :host {
      display: block;
    }
    
    .message {
      max-width: 80%;
      padding: 1rem 1.25rem;
      border-radius: 1rem;
      animation: fadeIn 0.2s ease-out;
      align-self: flex-start;
      background-color: var(--error-bg, #fef2f2);
      border-left: 4px solid var(--error-border, #ef4444);
    }
    
    @keyframes fadeIn { 
      from { opacity: 0; transform: translateY(10px); } 
      to { opacity: 1; transform: translateY(0); } 
    }
    
    .error-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }
    
    .error-icon {
      font-size: 1rem;
      flex-shrink: 0;
    }
    
    .error-label {
      font-weight: 600;
      font-size: 0.75rem;
      text-transform: uppercase;
      color: var(--error-border, #ef4444);
      letter-spacing: 0.05em;
    }
    
    .error-backend {
      font-size: 0.7rem;
      color: var(--text-secondary, #6b7280);
      margin-left: auto;
      font-family: monospace;
    }
    
    .error-message {
      font-size: 0.875rem;
      color: var(--error-text, #991b1b);
      white-space: pre-wrap;
      word-wrap: break-word;
      line-height: 1.5;
      font-family: monospace;
    }
    
    @media (prefers-color-scheme: dark) {
      .message {
        background-color: rgba(239, 68, 68, 0.1);
        border-left-color: #f87171;
      }
      
      .error-label {
        color: #f87171;
      }
      
      .error-message {
        color: #fca5a5;
      }
    }
  `;

  constructor() {
    super();
    this.message = '';
    this.backend = '';
    this.chunkId = '';
  }

  render() {
    return html`
      <div class="message" data-chunk-id=${this.chunkId}>
        <div class="error-header">
          <span class="error-icon">⚠️</span>
          <span class="error-label">LLM Error</span>
          ${this.backend ? html`<span class="error-backend">${this.backend}</span>` : ''}
        </div>
        <div class="error-message">${this.message}</div>
      </div>
    `;
  }
}

customElements.define('rx-message-error', RxMessageError);
