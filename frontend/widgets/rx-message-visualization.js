import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

export class RxMessageVisualization extends LitElement {
  static properties = {
    agentName: { type: String },
    pipeline: { type: Object },
    chunks: { type: Array },
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
      border-left: 4px solid #06b6d4;
      background-color: #ecfeff;
    }
    
    @keyframes fadeIn { 
      from { opacity: 0; transform: translateY(10px); } 
      to { opacity: 1; transform: translateY(0); } 
    }
    
    .visualization-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--border-color, #e5e7eb);
    }
    
    .visualization-icon {
      font-size: 1.2rem;
    }
    
    .visualization-title {
      font-weight: 600;
      font-size: 0.9rem;
      color: #06b6d4;
    }
    
    .visualization-desc {
      font-size: 0.75rem;
      color: var(--text-secondary, #6b7280);
      margin-top: 0.125rem;
    }
    
    .visualization-container {
      width: 100%;
      min-height: 300px;
      margin-top: 0.5rem;
      border-radius: 0.5rem;
      overflow: hidden;
    }
    
    .error-message {
      padding: 1rem;
      background-color: rgba(239, 68, 68, 0.1);
      border: 1px solid #ef4444;
      border-radius: 0.5rem;
      color: #ef4444;
      font-size: 0.875rem;
    }
    
    .debug-info {
      padding: 0.5rem;
      background-color: rgba(0, 0, 0, 0.05);
      border-radius: 0.25rem;
      font-family: monospace;
      font-size: 0.75rem;
      margin-top: 0.5rem;
    }
    
    /* Dark theme support */
    @media (prefers-color-scheme: dark) {
      .message {
        background-color: #083344;
        border-left-color: #22d3ee;
      }
      
      .visualization-title {
        color: #22d3ee;
      }
      
      .visualization-desc {
        color: #9ca3af;
      }
      
      .debug-info {
        background-color: rgba(255, 255, 255, 0.1);
        color: #e5e7eb;
      }
    }
    
    /* Responsive */
    @media (max-width: 768px) {
      .visualization-container {
        min-height: 250px;
      }
    }
    
    @media (max-width: 480px) {
      .visualization-container {
        min-height: 200px;
      }
    }
  `;

  constructor() {
    super();
    this.agentName = '';
    this.pipeline = null;
    this.chunks = [];
    this.chunkId = '';
  }
  
  connectedCallback() {
    super.connectedCallback();
    // Read initial data set before custom element was upgraded
    if (this._initialData) {
      this.chunkId = this._initialData.chunkId;
      this.agentName = this._initialData.agentName;
      this.pipeline = this._initialData.pipeline;
      this.chunks = this._initialData.chunks;
      delete this._initialData;
    }
  }

  _onContextMenu(e) {
    e.preventDefault();
    this.dispatchEvent(new CustomEvent('viz-contextmenu', {
      bubbles: true,
      composed: true,
      detail: { chunkId: this.chunkId, originalEvent: e }
    }));
  }

  render() {
    const hasValidPipeline = this.pipeline && typeof this.pipeline === 'object' && this.pipeline.name;
    const description = this.pipeline?.description;
    const opCount = this.pipeline?.operators?.length || 0;
    
    return html`
      <div class="message" data-chunk-id=${this.chunkId} @contextmenu=${this._onContextMenu}>
        <div class="visualization-header">
          <span class="visualization-icon">📊</span>
          <div>
            <div class="visualization-title">${this.agentName || 'Unknown Agent'}</div>
            ${description ? html`<div class="visualization-desc">${description}</div>` : ''}
          </div>
        </div>
        <div class="visualization-container">
          ${hasValidPipeline 
            ? html`<rx-marbles-visualizer .pipeline=${this.pipeline} .chunks=${this.chunks}></rx-marbles-visualizer>`
            : html`
                <div class="error-message">
                  No pipeline data available
                  ${this.pipeline ? html`<div class="debug-info">Received: ${JSON.stringify(this.pipeline).slice(0, 200)}</div>` : ''}
                </div>
              `
          }
        </div>
      </div>
    `;
  }
}

customElements.define('rx-message-visualization', RxMessageVisualization);
