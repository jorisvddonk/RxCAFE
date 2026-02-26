/**
 * AFE Text Component
 * Text input for string fields
 */

import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

export class AfeText extends LitElement {
  static properties = {
    name: { type: String },
    label: { type: String },
    value: { type: String },
    placeholder: { type: String },
    required: { type: Boolean },
    disabled: { type: Boolean },
    description: { type: String },
    error: { type: String },
    rows: { type: Number }
  };

  static styles = css`
    :host {
      display: block;
      margin-bottom: 1rem;
    }
    
    .afe-label {
      display: block;
      font-weight: 500;
      margin-bottom: 0.25rem;
      color: var(--afe-color-text, #1f2937);
    }
    
    .afe-label.required::after {
      content: "*";
      color: #dc2626;
      margin-left: 0.25rem;
    }
    
    .afe-input {
      width: 100%;
      padding: 0.5rem 1rem;
      font-size: 1rem;
      font-family: inherit;
      line-height: 1.5;
      color: var(--afe-color-text, #1f2937);
      background-color: var(--afe-color-background, #fff);
      border: 1px solid var(--afe-color-border, #d1d5db);
      border-radius: 0.5rem;
      transition: border-color 150ms ease-in-out, box-shadow 150ms ease-in-out;
      box-sizing: border-box;
    }
    
    .afe-input:focus {
      outline: none;
      border-color: var(--afe-color-border-focus, #2563eb);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.3);
    }
    
    .afe-input:disabled {
      background-color: var(--afe-color-background-disabled, #e5e7eb);
      cursor: not-allowed;
      opacity: 0.7;
    }
    
    .afe-input::placeholder {
      color: var(--afe-color-text-muted, #6b7280);
    }
    
    .afe-input.error {
      border-color: #dc2626;
    }
    
    .afe-input.error:focus {
      box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.3);
    }
    
    textarea.afe-input {
      resize: vertical;
      min-height: 80px;
    }
    
    .afe-description {
      color: var(--afe-color-text-muted, #6b7280);
      font-size: 0.875rem;
      margin-top: 0.25rem;
    }
    
    .afe-error-message {
      color: #dc2626;
      font-size: 0.875rem;
      margin-top: 0.25rem;
    }
  `;

  constructor() {
    super();
    this.name = '';
    this.label = '';
    this.value = '';
    this.placeholder = '';
    this.required = false;
    this.disabled = false;
    this.description = '';
    this.error = '';
    this.rows = 1;
  }

  _handleInput(e) {
    this.value = e.target.value;
    this.dispatchEvent(new CustomEvent('afe-change', {
      detail: { name: this.name, value: this.value },
      bubbles: true,
      composed: true
    }));
  }

  render() {
    console.log('[afe-text] render called, label:', this.label, 'value:', this.value);
    const isTextarea = this.rows > 1;
    
    return html`
      <label class="afe-label ${this.required ? 'required' : ''}">
        ${this.label}
      </label>
      ${isTextarea 
        ? html`
            <textarea
              class="afe-input ${this.error ? 'error' : ''}"
              .value=${this.value}
              placeholder=${this.placeholder}
              ?disabled=${this.disabled}
              rows=${this.rows}
              @input=${this._handleInput}
            ></textarea>
          `
        : html`
            <input
              type="text"
              class="afe-input ${this.error ? 'error' : ''}"
              .value=${this.value}
              placeholder=${this.placeholder}
              ?disabled=${this.disabled}
              @input=${this._handleInput}
            >
          `
      }
      ${this.description ? html`<p class="afe-description">${this.description}</p>` : ''}
      ${this.error ? html`<p class="afe-error-message">${this.error}</p>` : ''}
    `;
  }
}

customElements.define('afe-text', AfeText);
