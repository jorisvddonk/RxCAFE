/**
 * AFE Radio Component
 * Radio button group for enum fields
 */

import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

export class AfeRadio extends LitElement {
  static properties = {
    name: { type: String },
    label: { type: String },
    options: { type: Array },
    value: { type: String },
    required: { type: Boolean },
    disabled: { type: Boolean },
    description: { type: String },
    error: { type: String }
  };

  static styles = css`
    :host {
      display: block;
      margin-bottom: 1rem;
    }
    
    .afe-label {
      display: block;
      font-weight: 500;
      margin-bottom: 0.5rem;
      color: var(--afe-color-text, #1f2937);
    }
    
    .afe-label.required::after {
      content: "*";
      color: #dc2626;
      margin-left: 0.25rem;
    }
    
    .afe-radio-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    
    .afe-radio-option {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem;
      border-radius: 0.25rem;
      cursor: pointer;
      transition: background-color 150ms ease-in-out;
    }
    
    .afe-radio-option:hover {
      background-color: var(--afe-color-background-subtle, #f9fafb);
    }
    
    input[type="radio"] {
      width: 1.25rem;
      height: 1.25rem;
      accent-color: var(--afe-color-primary, #2563eb);
      cursor: pointer;
      margin: 0;
    }
    
    input[type="radio"]:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
    
    .afe-radio-label {
      flex: 1;
      cursor: pointer;
    }
    
    .afe-description {
      color: var(--afe-color-text-muted, #6b7280);
      font-size: 0.875rem;
      margin-top: 0.5rem;
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
    this.options = [];
    this.value = '';
    this.required = false;
    this.disabled = false;
    this.description = '';
    this.error = '';
  }

  _handleChange(e) {
    this.value = e.target.value;
    this.dispatchEvent(new CustomEvent('afe-change', {
      detail: { name: this.name, value: this.value },
      bubbles: true,
      composed: true
    }));
  }

  render() {
    console.log('[afe-radio] render called, label:', this.label, 'options:', this.options, 'value:', this.value);
    return html`
      <label class="afe-label ${this.required ? 'required' : ''}">
        ${this.label}
      </label>
      <div class="afe-radio-group">
        ${this.options.map(opt => html`
          <label class="afe-radio-option">
            <input
              type="radio"
              name=${this.name}
              value=${opt.value}
              .checked=${opt.value === this.value}
              ?disabled=${this.disabled}
              @change=${this._handleChange}
            >
            <span class="afe-radio-label">${opt.label}</span>
          </label>
        `)}
      </div>
      ${this.description ? html`<p class="afe-description">${this.description}</p>` : ''}
      ${this.error ? html`<p class="afe-error-message">${this.error}</p>` : ''}
    `;
  }
}

customElements.define('afe-radio', AfeRadio);
