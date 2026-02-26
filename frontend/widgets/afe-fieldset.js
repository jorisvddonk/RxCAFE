/**
 * AFE Fieldset Component
 * Wrapper for nested object fields
 */

import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

export class AfeFieldset extends LitElement {
  static properties = {
    name: { type: String },
    label: { type: String },
    collapsed: { type: Boolean }
  };

  static styles = css`
    :host {
      display: block;
      margin-bottom: 1rem;
    }
    
    .afe-fieldset {
      border: 1px solid var(--afe-color-border, #d1d5db);
      border-radius: 0.5rem;
      padding: 1rem;
      background-color: var(--afe-color-background-subtle, #f9fafb);
    }
    
    .afe-fieldset-legend {
      font-weight: 500;
      padding: 0 0.5rem;
      color: var(--afe-color-text, #1f2937);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .afe-fieldset-toggle {
      background: none;
      border: none;
      cursor: pointer;
      padding: 0;
      display: flex;
      align-items: center;
      color: var(--afe-color-text-muted, #6b7280);
      transition: transform 150ms ease-in-out;
    }
    
    .afe-fieldset-toggle.collapsed {
      transform: rotate(-90deg);
    }
    
    .afe-fieldset-content {
      margin-top: 1rem;
    }
    
    .afe-fieldset-content.collapsed {
      display: none;
    }
  `;

  constructor() {
    super();
    this.name = '';
    this.label = '';
    this.collapsed = false;
  }

  _toggleCollapse() {
    this.collapsed = !this.collapsed;
  }

  render() {
    console.log('[afe-fieldset] render called, label:', this.label);
    return html`
      <fieldset class="afe-fieldset">
        <legend class="afe-fieldset-legend">
          <button 
            type="button" 
            class="afe-fieldset-toggle ${this.collapsed ? 'collapsed' : ''}"
            @click=${this._toggleCollapse}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
            </svg>
          </button>
          ${this.label}
        </legend>
        <div class="afe-fieldset-content ${this.collapsed ? 'collapsed' : ''}">
          <slot></slot>
        </div>
      </fieldset>
    `;
  }
}

customElements.define('afe-fieldset', AfeFieldset);
