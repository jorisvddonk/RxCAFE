import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

export class RxMessageVisualization extends LitElement {
  static properties = {
    agentName: { type: String },
    pipeline: { type: String },
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
    
    .visualization-container {
      width: 100%;
      height: 400px;
      margin-top: 0.5rem;
      border-radius: 0.5rem;
      overflow: hidden;
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
    }
    
    /* Responsive */
    @media (max-width: 768px) {
      .visualization-container {
        height: 300px;
      }
    }
    
    @media (max-width: 480px) {
      .visualization-container {
        height: 200px;
      }
    }
  `;

  constructor() {
    super();
    this.agentName = '';
    this.pipeline = '';
    this.chunks = [];
    this.chunkId = '';
  }

  render() {
    return html`
      <div class="message" data-chunk-id=${this.chunkId}>
        <div class="visualization-header">
          <span class="visualization-icon">📊</span>
          <span class="visualization-title">RxMarbles Visualization: ${this.agentName}</span>
        </div>
        <div class="visualization-container">
          <rx-marbles-visualizer .pipeline=${this.pipeline} .chunks=${this.chunks}></rx-marbles-visualizer>
        </div>
      </div>
    `;
  }
}

customElements.define('rx-message-visualization', RxMessageVisualization);
