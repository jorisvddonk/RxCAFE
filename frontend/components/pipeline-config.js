import { LitElement, html, css } from 'lit';

export class PipelineConfig extends LitElement {
  static properties = {
    sessionId: { type: String },
    token: { type: String },
    apiBaseUrl: { type: String, attribute: 'api-base-url' },
    _toolsEnabled: { state: true },
    _weatherEnabled: { state: true },
    _voiceEnabled: { state: true },
    _loading: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      padding: 1.5rem;
      background: var(--surface-color, #fff);
      color: var(--text-color, #1f2937);
      font-family: system-ui, -apple-system, sans-serif;
    }

    h2 {
      margin: 0 0 0.5rem 0;
      font-size: 1.5rem;
    }

    .description {
      color: var(--text-secondary, #6b7280);
      margin-bottom: 1.5rem;
      line-height: 1.5;
    }

    .config-section {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .config-item {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 1rem;
      border: 1px solid var(--border-color, #e5e7eb);
      border-radius: 0.5rem;
      background: var(--bg-color, #f9fafb);
      cursor: pointer;
      transition: all 0.15s;
    }

    .config-item:hover {
      border-color: var(--primary-color, #2563eb);
      background: var(--focus-ring, rgba(37, 99, 235, 0.05));
    }

    .config-item input[type="checkbox"] {
      width: 1.25rem;
      height: 1.25rem;
      margin-top: 0.125rem;
      cursor: pointer;
      accent-color: var(--primary-color, #2563eb);
    }

    .config-item .label-content {
      flex: 1;
    }

    .config-item .title {
      font-weight: 600;
      font-size: 1rem;
      margin-bottom: 0.25rem;
    }

    .config-item .desc {
      font-size: 0.875rem;
      color: var(--text-secondary, #6b7280);
    }

    .actions {
      display: flex;
      gap: 0.75rem;
      margin-top: 1.5rem;
      justify-content: flex-end;
    }

    button {
      padding: 0.625rem 1.25rem;
      border-radius: 0.375rem;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }

    .btn-secondary {
      background: var(--bg-color, #f3f4f6);
      border: 1px solid var(--border-color, #d1d5db);
      color: var(--text-color, #374151);
    }

    .btn-secondary:hover {
      background: var(--border-color, #e5e7eb);
    }

    .btn-primary {
      background: var(--primary-color, #2563eb);
      border: 1px solid var(--primary-color, #2563eb);
      color: white;
    }

    .btn-primary:hover {
      background: var(--primary-hover, #1d4ed8);
    }

    .loading {
      opacity: 0.6;
      pointer-events: none;
    }
  `;

  constructor() {
    super();
    this._toolsEnabled = true;
    this._weatherEnabled = false;
    this._voiceEnabled = false;
    this._loading = false;
  }

  render() {
    return html`
      <div class="${this._loading ? 'loading' : ''}">
        <h2>⚡ Pipeline Settings</h2>
        <p class="description">
          Configure which features are enabled in the chat pipeline.
          Changes are saved to your session history.
        </p>

        <div class="config-section">
          <label class="config-item">
            <input 
              type="checkbox" 
              .checked=${this._toolsEnabled}
              @change=${(e) => this._toolsEnabled = e.target.checked}
            >
            <div class="label-content">
              <div class="title">🛠️ Tools</div>
              <div class="desc">Enable bash commands, file operations, web search, and more</div>
            </div>
          </label>

          <label class="config-item">
            <input 
              type="checkbox" 
              .checked=${this._weatherEnabled}
              @change=${(e) => this._weatherEnabled = e.target.checked}
            >
            <div class="label-content">
              <div class="title">🌤️ Weather</div>
              <div class="desc">Enable weather lookup tool for location-based forecasts</div>
            </div>
          </label>

          <label class="config-item">
            <input 
              type="checkbox" 
              .checked=${this._voiceEnabled}
              @change=${(e) => this._voiceEnabled = e.target.checked}
            >
            <div class="label-content">
              <div class="title">🔊 Voice</div>
              <div class="desc">Enable text-to-speech generation for assistant responses</div>
            </div>
          </label>
        </div>

        <div class="actions">
          <button class="btn-secondary" @click=${this._handleCancel}>Cancel</button>
          <button class="btn-primary" @click=${this._handleSave}>Save</button>
        </div>
      </div>
    `;
  }

  loadFromChunks(chunks) {
    let pipelineConfig = { tools: true, weather: false, voice: false };

    for (let i = chunks.length - 1; i >= 0; i--) {
      const chunk = chunks[i];
      if (chunk.contentType === 'null' && chunk.annotations?.['config.pipeline']) {
        pipelineConfig = chunk.annotations['config.pipeline'];
        break;
      }
    }

    this._toolsEnabled = pipelineConfig.tools !== false;
    this._weatherEnabled = pipelineConfig.weather === true;
    this._voiceEnabled = pipelineConfig.voice === true;
  }

  _handleCancel() {
    this.dispatchEvent(new CustomEvent('pipeline-cancel', { bubbles: true, composed: true }));
  }

  async _handleSave() {
    this._loading = true;

    const pipelineConfig = {
      tools: this._toolsEnabled,
      weather: this._weatherEnabled,
      voice: this._voiceEnabled
    };

    try {
      const url = new URL(`/api/session/${this.sessionId}/chunk`, this.apiBaseUrl);
      if (this.token) url.searchParams.set('token', this.token);

      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentType: 'null',
          producer: 'com.rxcafe.pipeline-config',
          annotations: {
            'config.type': 'runtime',
            'config.pipeline': pipelineConfig
          }
        })
      });

      const data = await response.json();

      if (data.success) {
        this.dispatchEvent(new CustomEvent('pipeline-saved', { 
          bubbles: true, 
          composed: true,
          detail: pipelineConfig
        }));
      } else {
        this.dispatchEvent(new CustomEvent('pipeline-error', { 
          bubbles: true, 
          composed: true,
          detail: data.error || 'Failed to save'
        }));
      }
    } catch (error) {
      this.dispatchEvent(new CustomEvent('pipeline-error', { 
        bubbles: true, 
        composed: true,
        detail: error.message
      }));
    } finally {
      this._loading = false;
    }
  }
}

customElements.define('pipeline-config', PipelineConfig);
