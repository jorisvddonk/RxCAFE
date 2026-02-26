/**
 * AFE Select Component
 * Dropdown select widget for enum fields
 */

import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

export class AfeSelect extends LitElement {
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
      margin-bottom: 0.25rem;
      color: var(--afe-color-text, #1f2937);
    }
    
    .afe-label.required::after {
      content: "*";
      color: #dc2626;
      margin-left: 0.25rem;
    }
    
    .afe-input-wrapper {
      position: relative;
    }
    
    select {
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
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e");
      background-position: right 0.5rem center;
      background-repeat: no-repeat;
      background-size: 1.5em 1.5em;
      padding-right: 2.5rem;
    }
    
    select:focus {
      outline: none;
      border-color: var(--afe-color-border-focus, #2563eb);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.3);
    }
    
    select:disabled {
      background-color: var(--afe-color-background-disabled, #e5e7eb);
      cursor: not-allowed;
      opacity: 0.7;
    }
    
    :host([error]) select {
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
    console.log('[afe-select] constructor called');
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
    console.log('[afe-select] render called, label:', this.label, 'options:', this.options, 'value:', this.value);
    return html`
      <label class="afe-label ${this.required ? 'required' : ''}">
        ${this.label}
      </label>
      <div class="afe-input-wrapper">
        <select
          .value=${this.value}
          ?disabled=${this.disabled}
          @change=${this._handleChange}
        >
          ${!this.value ? html`<option value="">Select...</option>` : ''}
          ${this.options.map(opt => html`
            <option value="${opt.value}" ?selected=${opt.value === this.value}>
              ${opt.label}
            </option>
          `)}
        </select>
      </div>
      ${this.description ? html`<p class="afe-description">${this.description}</p>` : ''}
      ${this.error ? html`<p class="afe-error-message">${this.error}</p>` : ''}
    `;
  }
}

customElements.define('afe-select', AfeSelect);
