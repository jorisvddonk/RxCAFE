/**
 * AFE Checkbox Component
 * Checkbox input for boolean fields
 */

import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

export class AfeCheckbox extends LitElement {
  static properties = {
    name: { type: String },
    label: { type: String },
    checked: { type: Boolean },
    disabled: { type: Boolean },
    description: { type: String }
  };

  static styles = css`
    :host {
      display: block;
      margin-bottom: 1rem;
    }
    
    .afe-checkbox-wrapper {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      cursor: pointer;
    }
    
    input[type="checkbox"] {
      width: 1.25rem;
      height: 1.25rem;
      accent-color: var(--afe-color-primary, #2563eb);
      cursor: pointer;
      margin: 0;
      flex-shrink: 0;
      margin-top: 0.125rem;
    }
    
    input[type="checkbox"]:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
    
    .afe-checkbox-label {
      flex: 1;
      cursor: pointer;
      line-height: 1.5;
      color: var(--afe-color-text, #1f2937);
    }
    
    .afe-description {
      color: var(--afe-color-text-muted, #6b7280);
      font-size: 0.875rem;
      margin-top: 0.25rem;
      margin-left: 2rem;
    }
  `;

  constructor() {
    super();
    this.name = '';
    this.label = '';
    this.checked = false;
    this.disabled = false;
    this.description = '';
  }

  _handleChange(e) {
    this.checked = e.target.checked;
    this.dispatchEvent(new CustomEvent('afe-change', {
      detail: { name: this.name, value: this.checked },
      bubbles: true,
      composed: true
    }));
  }

  render() {
    console.log('[afe-checkbox] render called, label:', this.label, 'checked:', this.checked);
    return html`
      <label class="afe-checkbox-wrapper">
        <input
          type="checkbox"
          .checked=${this.checked}
          ?disabled=${this.disabled}
          @change=${this._handleChange}
        >
        <span class="afe-checkbox-label">${this.label}</span>
      </label>
      ${this.description ? html`<p class="afe-description">${this.description}</p>` : ''}
    `;
  }
}

customElements.define('afe-checkbox', AfeCheckbox);
