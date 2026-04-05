import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';
import { BinaryRefMixin, formatByteSize } from './binary-ref-mixin.js';

export class RxMessageFile extends BinaryRefMixin(LitElement) {
  static properties = {
    ...LitElement.properties,
    role: { type: String, reflect: true },
    filename: { type: String },
    size: { type: Number },
    dataUrl: { type: String },
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
      max-width: 320px;
      padding: 0.75rem;
      border-radius: 0.75rem;
      animation: fadeIn 0.2s ease-out;
    }
    
    @keyframes fadeIn { 
      from { opacity: 0; transform: translateY(10px); } 
      to { opacity: 1; transform: translateY(0); } 
    }
    
    .message.user { 
      background-color: var(--user-bubble, #3b82f6); 
      color: var(--user-text, white); 
      border-bottom-right-radius: 0.25rem; 
    }
    
    .message.assistant { 
      background-color: var(--assistant-bubble, #f3f4f6); 
      color: var(--assistant-text, #1f2937); 
      border-bottom-left-radius: 0.25rem; 
    }
    
    .file-container {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    
    .file-icon {
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.1);
      border-radius: 0.5rem;
      font-size: 1.25rem;
    }
    
    .file-info {
      flex: 1;
      min-width: 0;
    }
    
    .filename {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 0.875rem;
    }
    
    .file-meta {
      font-size: 0.75rem;
      opacity: 0.7;
    }
    
    .download-btn {
      padding: 0.5rem 0.75rem;
      border: none;
      border-radius: 0.375rem;
      cursor: pointer;
      font-size: 0.75rem;
      font-weight: 500;
      transition: background-color 0.15s;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
    }
    
    .message.user .download-btn {
      background: rgba(255, 255, 255, 0.2);
      color: inherit;
    }
    
    .message.user .download-btn:hover {
      background: rgba(255, 255, 255, 0.3);
    }
    
    .message.assistant .download-btn {
      background: var(--user-bubble, #3b82f6);
      color: white;
    }
    
    .message.assistant .download-btn:hover {
      background: var(--user-bubble-hover, #2563eb);
    }

    .placeholder-state,
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
    this.filename = 'file';
    this.size = 0;
    this.dataUrl = '';
  }

  get extension() {
    const parts = this.filename.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
  }

  get fileIcon() {
    const ext = this.extension;
    const icons = {
      pdf: '📄',
      doc: '📝', docx: '📝',
      xls: '📊', xlsx: '📊',
      ppt: '📽️', pptx: '📽️',
      zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
      mp3: '🎵', wav: '🎵', ogg: '🎵', flac: '🎵',
      mp4: '🎬', avi: '🎬', mkv: '🎬', mov: '🎬',
      jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️',
      html: '🌐', css: '🎨', js: '⚡', json: '📋', xml: '📋',
      txt: '📃', md: '📃',
      exe: '⚙️', dll: '⚙️', bin: '⚙️',
    };
    return icons[ext] || '📁';
  }

  formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  _onBinaryLoaded(url, _mimeType) {
    this.dataUrl = url;
  }

  handleDownload() {
    if (!this.dataUrl) return;
    const a = document.createElement('a');
    a.href = this.dataUrl;
    a.download = this.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  render() {
    return html`
      <div class="message ${this.role}" data-chunk-id=${this.chunkId}>
        ${this._renderContent()}
      </div>
    `;
  }

  _renderContent() {
    switch (this._loadState) {
      case 'placeholder':
        return html`
          <div class="placeholder-state">
            <span class="placeholder-icon">📁</span>
            ${this.byteSize > 0
              ? html`<span class="placeholder-text">${formatByteSize(this.byteSize)}</span>`
              : ''}
          </div>
        `;
      case 'loading':
        return html`
          <div class="loading-state">
            <span class="placeholder-icon">📁</span>
            <span class="placeholder-text">Loading…</span>
          </div>
        `;
      case 'prompted':
        return html`
          <div class="prompted-state">
            <span class="placeholder-icon">📁</span>
            <div>File</div>
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
            <div>Failed to load file</div>
            <button @click=${() => this._retryFetch()}>Retry</button>
          </div>
        `;
      default: // 'rendered'
        return html`
          <div class="file-container">
            <div class="file-icon">${this.fileIcon}</div>
            <div class="file-info">
              <div class="filename" title="${this.filename}">${this.filename}</div>
              <div class="file-meta">${this.formatSize(this.size)} • ${this.mimeType}</div>
            </div>
            <button class="download-btn" @click=${this.handleDownload}>
              ⬇ Download
            </button>
          </div>
        `;
    }
  }
}

customElements.define('rx-message-file', RxMessageFile);
