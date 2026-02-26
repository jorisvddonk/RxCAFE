/**
 * AFE Number Component
 * Number input for numeric fields
 */

import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

export class AfeNumber extends LitElement {
  static properties = {
    name: { type: String },
    label: { type: String },
    value: { type: Number },
    min: { type: Number },
    max: { type: Number },
    step: { type: Number },
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
    
    .afe-input.error {
      border-color: #dc2626;
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
    this.value = null;
    this.min = undefined;
    this.max = undefined;
    this.step = 1;
    this.required = false;
    this.disabled = false;
    this.description = '';
    this.error = '';
  }

  _handleInput(e) {
    const val = e.target.value;
    this.value = val === '' ? null : parseFloat(val);
    this.dispatchEvent(new CustomEvent('afe-change', {
      detail: { name: this.name, value: this.value },
      bubbles: true,
      composed: true
    }));
  }

  render() {
    console.log('[afe-number] render called, label:', this.label, 'value:', this.value);
    return html`
      <label class="afe-label ${this.required ? 'required' : ''}">
        ${this.label}
      </label>
      <input
        type="number"
        class="afe-input ${this.error ? 'error' : ''}"
        .value=${this.value}
        min=${this.min !== undefined ? this.min : ''}
        max=${this.max !== undefined ? this.max : ''}
        step=${this.step}
        ?disabled=${this.disabled}
        @input=${this._handleInput}
      >
      ${this.description ? html`<p class="afe-description">${this.description}</p>` : ''}
      ${this.error ? html`<p class="afe-error-message">${this.error}</p>` : ''}
    `;
  }
}

customElements.define('afe-number', AfeNumber);
