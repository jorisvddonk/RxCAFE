/**
 * Pipeline Config UI Adapter
 * 
 * Manages the pipeline config Lit component for customizing agent pipeline features.
 */

import { PipelineConfig } from '../components/pipeline-config.js';

export class PipelineConfigAdapter {
  constructor(chat) {
    this.chat = chat;
    this.component = null;
    this.container = null;
  }

  init(sessionId) {
    this.container = document.getElementById('dice-view');
    if (!this.container) {
      console.error('[PipelineConfig] Container #dice-view not found');
      return;
    }

    this._createComponent(sessionId);
    this._bindEvents();
  }

  _createComponent(sessionId) {
    this.container.innerHTML = '';
    
    this.component = document.createElement('pipeline-config');
    this.component.sessionId = sessionId;
    this.component.token = this.chat.token;
    this.component.apiBaseUrl = window.location.origin;

    if (this.chat.rawChunks) {
      this.component.loadFromChunks(this.chat.rawChunks);
    }

    this.container.appendChild(this.component);
  }

  _bindEvents() {
    if (!this.component) return;

    this.component.addEventListener('pipeline-cancel', () => {
      this.chat.showUIMode('chat');
    });

    this.component.addEventListener('pipeline-saved', (e) => {
      const config = e.detail;
      this.chat.addSystemMessage(`Pipeline config updated: tools=${config.tools}, weather=${config.weather}, voice=${config.voice}`);
      this.chat.showUIMode('chat');
    });

    this.component.addEventListener('pipeline-error', (e) => {
      this.chat.showError(e.detail);
    });
  }

  show() {
    if (this.component && this.chat.rawChunks) {
      this.component.loadFromChunks(this.chat.rawChunks);
    }
  }

  hide() {
    if (this.container) {
      this.container.innerHTML = '';
    }
    this.component = null;
  }

  destroy() {
    this.hide();
  }
}
