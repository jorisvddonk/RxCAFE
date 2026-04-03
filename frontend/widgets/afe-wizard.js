/**
 * AFE Wizard Component
 * Main wizard orchestrator for agent-based session creation
 * 
 * 3-step wizard:
 * 1. Select Agent
 * 2. Agent Configuration (dynamic form)
 * 3. Review & Create
 */

import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';
import './afe-select.js';
import './afe-radio.js';
import './afe-text.js';
import './afe-number.js';
import './afe-checkbox.js';
import './afe-fieldset.js';

export class AfeWizard extends LitElement {
  static properties = {
    agents: { type: Array },
    presets: { type: Array },
    currentStep: { type: Number },
    selectedAgent: { type: Object },
    selectedPreset: { type: Object },
    formData: { type: Object },
    models: { type: Array },
    loadingModels: { type: Boolean },
    error: { type: String },
    apiUrl: { type: String }
  };

  static styles = css`
    :host {
      display: block;
      width: 100%;
    }
    
    * {
      box-sizing: border-box;
    }
    
    .afe-wizard {
      width: 100%;
    }
    
    .afe-wizard-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid var(--afe-color-border, #d1d5db);
    }
    
    .afe-wizard-header h2 {
      margin: 0;
      font-size: 1.25rem;
      color: var(--afe-color-text, #1f2937);
    }
    
    .afe-wizard-close {
      background: none;
      border: none;
      font-size: 1.25rem;
      cursor: pointer;
      color: var(--afe-color-text-muted, #6b7280);
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
    }
    
    .afe-wizard-close:hover {
      background-color: var(--afe-color-background-subtle, #f9fafb);
      color: var(--afe-color-text, #1f2937);
    }
    
    .afe-wizard-steps {
      display: flex;
      justify-content: space-between;
      margin-bottom: 1.5rem;
      border-bottom: 1px solid var(--afe-color-border, #d1d5db);
      padding-bottom: 0.5rem;
    }
    
    .afe-wizard-step {
      flex: 1;
      text-align: center;
      padding: 0.5rem;
      color: var(--afe-color-text-muted, #6b7280);
      font-size: 0.875rem;
      font-weight: 500;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
    }
    
    .afe-wizard-step.active {
      color: var(--afe-color-primary, #2563eb);
      border-bottom-color: var(--afe-color-primary, #2563eb);
    }
    
    .afe-wizard-step.completed {
      color: var(--afe-color-success, #16a34a);
    }
    
    .afe-wizard-step-number {
      display: inline-block;
      width: 1.5rem;
      height: 1.5rem;
      line-height: 1.5rem;
      border-radius: 50%;
      background-color: var(--afe-color-background-subtle, #f9fafb);
      margin-right: 0.25rem;
      font-size: 0.75rem;
    }
    
    .afe-wizard-step.active .afe-wizard-step-number {
      background-color: var(--afe-color-primary, #2563eb);
      color: white;
    }
    
    .afe-wizard-step.completed .afe-wizard-step-number {
      background-color: var(--afe-color-success, #16a34a);
      color: white;
    }
    
    .afe-wizard-content {
      min-height: 250px;
    }
    
    .afe-wizard-actions {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      margin-top: 1.5rem;
      padding-top: 1rem;
      border-top: 1px solid var(--afe-color-border, #d1d5db);
    }
    
    .afe-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.5rem 1rem;
      font-size: 1rem;
      font-weight: 500;
      font-family: inherit;
      border-radius: 0.5rem;
      border: none;
      cursor: pointer;
      transition: all 150ms ease-in-out;
      text-decoration: none;
    }
    
    .afe-btn:focus {
      outline: none;
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.3);
    }
    
    .afe-btn-primary {
      background-color: var(--afe-color-primary, #2563eb);
      color: white;
    }
    
    .afe-btn-primary:hover {
      background-color: var(--afe-color-primary-hover, #1d4ed8);
    }
    
    .afe-btn-primary:disabled {
      background-color: var(--afe-color-background-disabled, #e5e7eb);
      cursor: not-allowed;
    }
    
    .afe-btn-secondary {
      background-color: transparent;
      color: var(--afe-color-text, #1f2937);
      border: 1px solid var(--afe-color-border, #d1d5db);
    }
    
    .afe-btn-secondary:hover {
      background-color: var(--afe-color-background-subtle, #f9fafb);
    }
    
    .afe-btn-danger {
      background-color: #dc2626;
      color: white;
    }
    
    .afe-btn-danger:hover {
      background-color: #b91c1c;
    }
    
    /* Agent Selection */
    .agent-option {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 0.75rem;
      border: 1px solid var(--afe-color-border, #d1d5db);
      border-radius: 0.5rem;
      cursor: pointer;
      margin-bottom: 0.5rem;
      transition: all 150ms ease-in-out;
    }
    
    .agent-option:hover {
      background-color: var(--afe-color-background-subtle, #f9fafb);
    }
    
    .agent-option.selected {
      border-color: var(--afe-color-primary, #2563eb);
      background-color: var(--afe-color-primary-light, #dbeafe);
    }
    
    .agent-option input[type="radio"] {
      margin-top: 0.25rem;
      accent-color: var(--afe-color-primary, #2563eb);
    }
    
    .agent-info {
      flex: 1;
    }
    
    .agent-name {
      font-weight: 600;
      color: var(--afe-color-text, #1f2937);
    }
    
    .agent-badge {
      display: inline-block;
      font-size: 0.75rem;
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
      background-color: var(--afe-color-background-subtle, #f3f4f6);
      color: var(--afe-color-text-muted, #6b7280);
      margin-left: 0.5rem;
    }
    
    .agent-description {
      font-size: 0.875rem;
      color: var(--afe-color-text-muted, #6b7280);
      margin-top: 0.25rem;
    }
    
    /* Review */
    .afe-review {
      background-color: var(--afe-color-background-subtle, #f9fafb);
      border-radius: 0.5rem;
      padding: 1rem;
    }
    
    .afe-review-item {
      display: flex;
      justify-content: space-between;
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--afe-color-border, #d1d5db);
    }
    
    .afe-review-item:last-child {
      border-bottom: none;
    }
    
    .afe-review-label {
      color: var(--afe-color-text-muted, #6b7280);
    }
    
    .afe-review-value {
      font-weight: 500;
      color: var(--afe-color-text, #1f2937);
    }
    
    /* No config message */
    .no-config-message {
      text-align: center;
      padding: 2rem;
      color: var(--afe-color-text-muted, #6b7280);
    }
    
    .no-config-icon {
      font-size: 3rem;
      margin-bottom: 1rem;
    }
    
    /* Loading */
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
      color: var(--afe-color-text-muted, #6b7280);
    }
    
    .spinner {
      width: 1.5rem;
      height: 1.5rem;
      border: 2px solid var(--afe-color-border, #d1d5db);
      border-top-color: var(--afe-color-primary, #2563eb);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-right: 0.5rem;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    /* Error */
    .error-message {
      background-color: #fef2f2;
      border: 1px solid #fecaca;
      color: #dc2626;
      padding: 0.75rem;
      border-radius: 0.5rem;
      margin-bottom: 1rem;
    }
    
    /* Mobile responsive */
    @media (max-width: 640px) {
      .afe-wizard-steps {
        flex-direction: column;
        align-items: stretch;
        border-bottom: none;
        gap: 0.25rem;
      }
      
      .afe-wizard-step {
        display: flex;
        align-items: center;
        text-align: left;
        padding: 0.5rem;
        border-radius: 0.25rem;
        border-bottom: none;
      }
      
      .afe-wizard-step.active {
        background-color: var(--afe-color-primary-light, #dbeafe);
      }
      
      .afe-wizard-actions {
        flex-direction: column;
      }
      
      .afe-wizard-actions .afe-btn {
        width: 100%;
      }
    }
  `;

  constructor() {
    super();
    this.agents = [];
    this.presets = [];
    this.currentStep = 1;
    this.selectedAgent = null;
    this.selectedPreset = null;
    this.formData = {};
    this.models = [];
    this.loadingModels = false;
    this.error = '';
    this.apiUrl = '';
  }

  reset() {
    this.currentStep = 1;
    this.selectedAgent = null;
    this.selectedPreset = null;
    this.formData = {};
    this.models = [];
    this.loadingModels = false;
    this.error = '';
  }
  
  _close() {
    this.dispatchEvent(new CustomEvent('afe-wizard-close', {
      bubbles: true,
      composed: true
    }));
  }
  
  connectedCallback() {
    super.connectedCallback();
    this.formData = {};
    this.currentStep = 1;
  }

  updated(changedProperties) {
    console.log('[WIZARD] updated called, agents:', this.agents?.length, 'selectedAgent:', this.selectedAgent?.name);
    // Auto-select default agent when agents are set
    if (changedProperties.has('agents') && this.agents && this.agents.length > 0 && !this.selectedAgent) {
      const defaultAgent = this.agents.find(a => a.name === 'default') || this.agents[0];
      console.log('[WIZARD] auto-selecting agent:', defaultAgent?.name);
      if (defaultAgent) {
        this._handleAgentSelect(defaultAgent);
      }
    }
  }

  _getAgentRequiresLLM(agent) {
    console.log('[WIZARD] _getAgentRequiresLLM called with:', agent?.name);
    if (!agent || !agent.configSchema) {
      console.log('[WIZARD] _getAgentRequiresLLM: no agent or no configSchema, returning false');
      return false;
    }
    const schema = agent.configSchema;
    console.log('[WIZARD] _getAgentRequiresLLM: schema.properties:', schema.properties);
    if (!schema.properties) return false;
    const result = !!(schema.properties.backend || schema.properties.model);
    console.log('[WIZARD] _getAgentRequiresLLM: returning:', result);
    return result;
  }

  _getRequiredFields(agent) {
    if (!agent || !agent.configSchema) return [];
    return agent.configSchema.required || [];
  }

  _getSchemaProperties(agent) {
    console.log('[WIZARD] _getSchemaProperties called for:', agent?.name);
    if (!agent || !agent.configSchema) {
      console.log('[WIZARD] _getSchemaProperties: no configSchema, returning {}');
      return {};
    }
    console.log('[WIZARD] _getSchemaProperties: returning:', agent.configSchema.properties);
    return agent.configSchema.properties || {};
  }

  _getEnumOptions(prop) {
    if (!prop.enum || !prop.enumLabels) {
      return (prop.enum || []).map(v => ({ value: v, label: v }));
    }
    return prop.enum.map((v, i) => ({
      value: v,
      label: prop.enumLabels[i] || v
    }));
  }

  _createWidget(prop, propName, required) {
    const common = {
      name: propName,
      label: prop.description || propName,
      required: required,
      description: prop.ui?.description,
      disabled: false
    };

    // Auto-generate options for known fields without enum
    let generatedEnum = null;
    if (!prop.enum && propName === 'backend') {
      // Known LLM backends
      generatedEnum = [
        { value: 'kobold', label: 'KoboldCPP' },
        { value: 'ollama', label: 'Ollama' },
        { value: 'llamacpp', label: 'LlamaCPP' }
      ];
    }
    if (!prop.enum && propName === 'model' && this.formData.backend) {
      // Model field - use radio buttons if we have few options, otherwise dropdown
      generatedEnum = this.models.length > 0 
        ? this.models 
        : [{ value: 'gemma3:1b', label: 'gemma3:1b (default)' }];
    }

    // Handle enum types (including auto-generated)
    if (prop.enum || generatedEnum) {
      const options = generatedEnum || this._getEnumOptions(prop);
      const useRadio = prop.ui?.widget === 'radio' || (options.length <= 3 && !prop.ui?.widget);
      if (useRadio) {
        return html`<afe-radio name="${propName}" label="${prop.description || propName}" required="${required}" .options=${options} .value=${this.formData[propName] || ''}></afe-radio>`;
      }
      return html`<afe-select name="${propName}" label="${prop.description || propName}" required="${required}" .options=${options} .value=${this.formData[propName] || ''}></afe-select>`;
    }

    // Handle boolean
    if (prop.type === 'boolean') {
      return html`<afe-checkbox name="${propName}" label="${prop.description || propName}" .checked=${this.formData[propName] || false}></afe-checkbox>`;
    }

    // Handle number
    if (prop.type === 'number' || prop.type === 'integer') {
      return html`
        <afe-number
          name="${propName}"
          label="${prop.description || propName}"
          required="${required}"
          .value=${this.formData[propName] ?? null}
          min="${prop.minimum !== undefined ? prop.minimum : ''}"
          max="${prop.maximum !== undefined ? prop.maximum : ''}"
          step="${prop.multipleOf ? prop.multipleOf : (prop.type === 'integer' ? 1 : 'any')}"
        ></afe-number>
      `;
    }

    // Handle object (nested)
    if (prop.type === 'object' && prop.properties) {
      const nestedFields = Object.entries(prop.properties).map(([nestedName, nestedProp]) => {
        const nestedRequired = (prop.required || []).includes(nestedName);
        return this._createWidget(nestedProp, `${propName}.${nestedName}`, nestedRequired);
      });
      return html`<afe-fieldset label="${prop.description || propName}">${nestedFields}</afe-fieldset>`;
    }

    // Default to text (string)
    const rows = prop.ui?.rows || 1;
    if (rows > 1) {
      return html`<afe-text name="${propName}" label="${prop.description || propName}" required="${required}" .value=${this.formData[propName] || ''} rows="${rows}"></afe-text>`;
    }
    return html`<afe-text name="${propName}" label="${prop.description || propName}" required="${required}" .value=${this.formData[propName] || ''}></afe-text>`;
  }

  _handleFieldChange(e) {
    const { name, value } = e.detail;
    this.formData = { ...this.formData, [name]: value };
  }

  _handleAgentSelect(agent) {
    console.log('[WIZARD] _handleAgentSelect called for:', agent?.name);
    this.selectedAgent = agent;
    this.selectedPreset = null;
    
    // Initialize formData with defaults from schema
    const schema = agent.configSchema;
    console.log('[WIZARD] schema.default:', schema?.default);
    let formData = {};
    
    // Apply top-level defaults
    if (schema.default) {
      formData = { ...schema.default };
      console.log('[WIZARD] applied schema.default, formData:', formData);
    }
    
    // If agent needs LLM and has backend property, set default
    if (this._getAgentRequiresLLM(agent)) {
      const props = this._getSchemaProperties(agent);
      
        // Set backend default if not already set (default to ollama)
        if (props.backend && props.backend.default) {
          formData = { ...formData, backend: props.backend.default };
        } else if (props.backend && !formData.backend) {
          formData = { ...formData, backend: 'ollama' };
        }
      
      // Load models for default backend
      if (formData.backend === 'ollama' || formData.backend === 'llamacpp') {
        this._loadOllamaModels();
      }
    }
    
    this.formData = formData;
  }

  _handlePresetSelect(preset) {
    console.log('[WIZARD] _handlePresetSelect called for:', preset?.name);
    this.selectedPreset = preset;
    
    if (!preset) {
      // If no preset selected, reset to agent selection
      this.selectedAgent = null;
      this.formData = {};
      return;
    }
    
    // Find the agent for this preset
    const agent = this.agents.find(a => a.name === preset.agentId);
    if (!agent) {
      this.error = `Agent '${preset.agentId}' from preset not found`;
      return;
    }
    
    this.selectedAgent = agent;
    
    // Apply preset config to formData
    let formData = {};
    if (preset.backend) formData.backend = preset.backend;
    if (preset.model) formData.model = preset.model;
    if (preset.systemPrompt) formData.systemPrompt = preset.systemPrompt;
    if (preset.llmParams) formData.llmParams = preset.llmParams;
    
    // Load models if ollama or llamacpp backend
    if (preset.backend === 'ollama' || preset.backend === 'llamacpp') {
      this._loadOllamaModels();
    }
    
    this.formData = formData;
    this.error = '';
    
    // Auto-advance to step 3 (review) if we have preset data
    this.currentStep = 3;
  }

  async _loadOllamaModels() {
    console.log('[WIZARD] _loadOllamaModels called');
    this.loadingModels = true;
    try {
      const token = window.RXCAFE_TOKEN || '';
      const baseUrl = window.location.origin;
      const url = new URL('/api/models', baseUrl);
      const backend = this.formData.backend || 'ollama';
      url.searchParams.set('backend', backend);
      if (token) {
        url.searchParams.set('token', token);
      }
      console.log('[WIZARD] final url:', url.toString());
      const response = await fetch(url.toString());
      console.log('[WIZARD] response status:', response.status);
      const data = await response.json();
      if (data.models) {
        this.models = data.models.map(m => ({ value: m, label: m }));
      }
    } catch (err) {
      console.error('Failed to load models:', err);
      this.models = [{ value: 'gemma3:1b', label: 'gemma3:1b (default)' }];
    }
    this.loadingModels = false;
  }

  async _handleBackendChange(backend) {
    this.formData = { ...this.formData, backend };
    if (backend === 'ollama' || backend === 'llamacpp') {
      await this._loadOllamaModels();
    }
  }

  _nextStep() {
    console.log('[WIZARD] _nextStep called, currentStep:', this.currentStep, 'selectedAgent:', this.selectedAgent?.name);
    
    if (this.currentStep === 1) {
      console.log('[WIZARD] Step 1 - checking agent selection');
      if (!this.selectedAgent) {
        console.log('[WIZARD] Step 1 - no agent selected!');
        this.error = 'Please select an agent';
        return;
      }
      
      console.log('[WIZARD] Step 1 - agent selected:', this.selectedAgent.name);
      console.log('[WIZARD] Step 1 - calling _getAgentRequiresLLM');
      const requiresLLM = this._getAgentRequiresLLM(this.selectedAgent);
      console.log('[WIZARD] Step 1 - requiresLLM:', requiresLLM);
      
      // Initialize default backend if agent needs LLM
      if (requiresLLM) {
        const props = this._getSchemaProperties(this.selectedAgent);
        console.log('[WIZARD] Step 1 - props:', props);
        console.log('[WIZARD] Step 1 - props.backend:', props.backend);
        console.log('[WIZARD] Step 1 - formData.backend before:', this.formData.backend);
        
        if (props.backend && !this.formData.backend) {
          // Set default backend (default to ollama)
          const defaultBackend = 'ollama';
          this.formData = { ...this.formData, backend: defaultBackend };
          console.log('[WIZARD] Step 1 - set formData.backend to:', defaultBackend);
          
          // Load models if default is ollama or llamacpp
          if (defaultBackend === 'ollama' || defaultBackend === 'llamacpp') {
            this._loadOllamaModels();
          }
        }
        console.log('[WIZARD] Step 1 - formData.backend after:', this.formData.backend);
      }
      
      this.error = '';
      this.currentStep = 2;
      console.log('[WIZARD] Step 1 complete, now on step 2');
    } else if (this.currentStep === 2) {
      console.log('[WIZARD] Step 2 - validating');
      // Validate LLM config if agent requires it
      if (this._getAgentRequiresLLM(this.selectedAgent)) {
        const props = this._getSchemaProperties(this.selectedAgent);
        if (props.backend && !this.formData.backend) {
          console.log('[WIZARD] Step 2 - NO BACKEND SELECTED!');
          this.error = 'Please select a backend';
          return;
        }
        if (props.model && (this.formData.backend === 'ollama' || this.formData.backend === 'llamacpp') && !this.formData.model) {
          this.error = 'Please select a model';
          return;
        }
      }
      
      // Validate required fields
      const required = this._getRequiredFields(this.selectedAgent);
      for (const field of required) {
        if (this.formData[field] === undefined || this.formData[field] === '' || this.formData[field] === null) {
          this.error = `Please fill in required field: ${field}`;
          return;
        }
      }
      
      // For agents without LLM config, skip to review
      if (!this._getAgentRequiresLLM(this.selectedAgent)) {
        this.currentStep = 3;
      } else {
        this.error = '';
        this.currentStep = 3;
      }
    }
    
    this.dispatchEvent(new CustomEvent('afe-wizard-step', {
      detail: { step: this.currentStep },
      bubbles: true,
      composed: true
    }));
  }

  _prevStep() {
    if (this.currentStep > 1) {
      this.currentStep--;
      this.error = '';
    }
  }

  _createSession() {
    // Merge flat llmParams.* keys into nested llmParams object
    const config = { ...this.formData };
    const llmParamKeys = ['temperature', 'maxTokens', 'topP', 'topK', 'repeatPenalty', 'stop', 'stopTokenStrip', 'seed', 'maxContextLength', 'numCtx'];
    for (const key of llmParamKeys) {
      const flatKey = `llmParams.${key}`;
      if (config[flatKey] !== undefined) {
        if (!config.llmParams) config.llmParams = {};
        let val = config[flatKey];
        // Convert comma-separated string back to array for stop tokens
        if (key === 'stop' && typeof val === 'string') {
          val = val.split(',').map(s => s.trim()).filter(s => s.length > 0);
        }
        // Convert string to boolean for stopTokenStrip
        if (key === 'stopTokenStrip') {
          val = val === true || val === 'true' || val === '1';
        }
        config.llmParams[key] = val;
        delete config[flatKey];
      }
    }
    
    this.dispatchEvent(new CustomEvent('afe-wizard-complete', {
      detail: {
        agentId: this.selectedAgent.name,
        config
      },
      bubbles: true,
      composed: true
    }));
  }

  _getToken() {
    return window.RXCAFE_TOKEN || new URLSearchParams(window.location.search).get('token');
  }

  async _saveAsPreset() {
    const name = prompt('Enter a name for this preset:');
    if (!name || !name.trim()) return;
    
    const description = prompt('Enter a description (optional):') || undefined;
    
    const token = this._getToken();
    const url = new URL('/api/presets', this.apiUrl);
    if (token) url.searchParams.set('token', token);
    
    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          agentId: this.selectedAgent.name,
          backend: this.formData.backend,
          model: this.formData.model,
          systemPrompt: this.formData.systemPrompt,
          llmParams: this.formData.llmParams,
          description
        })
      });
      
      const data = await response.json();
      
      if (data.success) {
        alert(`Preset '${name}' created successfully!`);
        // Reload presets
        this.dispatchEvent(new CustomEvent('afe-wizard-preset-created', {
          bubbles: true,
          composed: true
        }));
      } else {
        alert('Failed to create preset: ' + (data.error || data.message));
      }
    } catch (err) {
      alert('Failed to create preset: ' + err.message);
    }
  }

  _renderStep1() {
    return html`
      <h3>Select an Agent</h3>
      <p style="color: var(--afe-color-text-muted, #6b7280); margin-bottom: 1rem;">
        Choose which agent to use for this session.
      </p>
      
      ${this.presets && this.presets.length > 0 ? html`
        <div style="margin-bottom: 1.5rem; padding: 1rem; background: var(--afe-color-background-subtle, #f9fafb); border-radius: 0.5rem;">
          <h4 style="margin: 0 0 0.75rem 0; font-size: 0.875rem; color: var(--afe-color-text-muted, #6b7280);">Or select a preset</h4>
          <afe-select
            name="preset"
            label=""
            required="false"
            .options=${[{ value: '', label: 'Choose a preset (optional)' }, ...this.presets.map(p => ({ value: p.name, label: p.name + (p.description ? ` - ${p.description}` : '') }))]}
            .value=${this.selectedPreset?.name || ''}
            @afe-change=${(e) => {
              const preset = this.presets.find(p => p.name === e.detail.value);
              this._handlePresetSelect(preset);
            }}
          ></afe-select>
        </div>
      ` : ''}
      
      ${this.agents.map(agent => html`
        <label class="agent-option ${this.selectedAgent?.name === agent.name ? 'selected' : ''}">
          <input
            type="radio"
            name="agent"
            .checked=${this.selectedAgent?.name === agent.name}
            @change=${() => this._handleAgentSelect(agent)}
          >
          <div class="agent-info">
            <span class="agent-name">${agent.name}</span>
            ${agent.startInBackground ? html`<span class="agent-badge">background</span>` : ''}
            ${agent.description ? html`<p class="agent-description">${agent.description}</p>` : ''}
          </div>
        </label>
      `)}
    `;
  }

    _renderStep2() {
    const props = this._getSchemaProperties(this.selectedAgent);
    const required = this._getRequiredFields(this.selectedAgent);
    const needsLLM = this._getAgentRequiresLLM(this.selectedAgent);
    
    // Check if agent has any config fields
    const hasConfig = Object.keys(props).length > 0;
    
    if (!hasConfig) {
      return html`
        <div class="no-config-message">
          <div class="no-config-icon">⚙️</div>
          <p><strong>No configuration needed</strong></p>
          <p>The "${this.selectedAgent.name}" agent doesn't require any additional configuration.</p>
        </div>
      `;
    }
    
    return html`
      <h3>Configure ${this.selectedAgent.name}</h3>
      <p style="color: var(--afe-color-text-muted, #6b7280); margin-bottom: 1rem;">
        Set up the agent-specific configuration options.
      </p>
      
      <div @afe-change=${this._handleFieldChange}>
        ${Object.entries(props).map(([propName, prop]) => {
          const isRequired = required.includes(propName);
          
          // Handle backend specially - need to load models for ollama
          if (propName === 'backend') {
            // Auto-generate options if no enum
            const options = prop.enum 
              ? prop.enum.map(v => ({ value: v, label: v }))
              : [
                  { value: 'kobold', label: 'KoboldCPP' },
                  { value: 'ollama', label: 'Ollama' },
                  { value: 'llamacpp', label: 'LlamaCPP' }
                ];
            return html`
              <afe-radio
                name="backend"
                label="Backend"
                required
                .options=${options}
                .value=${this.formData.backend || ''}
                @afe-change=${(e) => this._handleBackendChange(e.detail.value)}
              ></afe-radio>
            `;
          }
          
          // Handle model specially - if ollama or llamacpp, show dropdown with loaded models
          if (propName === 'model') {
            const isOllama = this.formData.backend === 'ollama' || this.formData.backend === 'llamacpp';
            if (isOllama) {
              const modelOptions = this.loadingModels 
                ? [{ value: '', label: 'Loading...' }]
                : this.models.length > 0 
                  ? this.models 
                  : [{ value: 'gemma3:1b', label: 'gemma3:1b (default)' }];
              return html`
                <afe-select
                  name="model"
                  label="Model"
                  required
                  ?disabled=${this.loadingModels}
                  .options=${modelOptions}
                  .value=${this.formData.model || ''}
                ></afe-select>
              `;
            }
            // Kobold - model is optional, show a default
            return html`<afe-text name="model" label="Model (optional - leave empty for default)" .value=${this.formData.model || ''}></afe-text>`;
          }
          
          // Handle llmParams specially - it's an object with nested fields
          if (propName === 'llmParams') {
            const nestedFields = Object.entries(prop.properties || {}).map(([nestedName, nestedProp]) => {
              const nestedRequired = (prop.required || []).includes(nestedName);
              // Auto-generate options for known nested fields
              let generatedEnum = null;
              if (!nestedProp.enum && nestedName === 'temperature') {
                generatedEnum = [
                  { value: '0.1', label: '0.1 (focused)' },
                  { value: '0.5', label: '0.5 (balanced)' },
                  { value: '0.7', label: '0.7 (default)' },
                  { value: '1.0', label: '1.0 (creative)' }
                ];
              }
              if (!nestedProp.enum && nestedName === 'maxTokens') {
                generatedEnum = [
                  { value: '256', label: '256' },
                  { value: '500', label: '500' },
                  { value: '1000', label: '1000' },
                  { value: '2000', label: '2000' }
                ];
              }
              
              const common = {
                name: `llmParams.${nestedName}`,
                label: nestedProp.description || nestedName,
                required: nestedRequired,
                disabled: false
              };
              
              if (generatedEnum) {
                return html`<afe-select name="llmParams.${nestedName}" label="${nestedProp.description || nestedName}" required="${nestedRequired}" .options=${generatedEnum} .value=${this.formData.llmParams?.[nestedName] || ''}></afe-select>`;
              }
              if (nestedProp.type === 'boolean') {
                return html`<afe-checkbox name="llmParams.${nestedName}" label="${nestedProp.description || nestedName}" .checked=${this.formData.llmParams?.[nestedName] ?? false}></afe-checkbox>`;
              }
              if (nestedProp.type === 'number' || nestedProp.type === 'integer') {
                return html`<afe-number name="llmParams.${nestedName}" label="${nestedProp.description || nestedName}" required="${nestedRequired}" .value=${this.formData.llmParams?.[nestedName] ?? null}></afe-number>`;
              }
              if (nestedProp.type === 'array') {
                const arrVal = this.formData.llmParams?.[nestedName];
                const displayVal = Array.isArray(arrVal) ? arrVal.join(', ') : '';
                return html`<afe-text name="llmParams.${nestedName}" label="${nestedProp.description || nestedName}" required="${nestedRequired}" .value=${displayVal} placeholder="Comma-separated values"></afe-text>`;
              }
              return html`<afe-text name="llmParams.${nestedName}" label="${nestedProp.description || nestedName}" required="${nestedRequired}" .value=${this.formData.llmParams?.[nestedName] || ''}></afe-text>`;
            });
            
            return html`<afe-fieldset label="${prop.description || 'Advanced Options'}">${nestedFields}</afe-fieldset>`;
          }
          
          return this._createWidget(prop, propName, isRequired);
        })}
      </div>
    `;
  }

  _renderStep3() {
    return html`
      <h3>Review & Create</h3>
      <p style="color: var(--afe-color-text-muted, #6b7280); margin-bottom: 1rem;">
        Review your session configuration before creating.
      </p>
      
      <div class="afe-review">
        <div class="afe-review-item">
          <span class="afe-review-label">Agent</span>
          <span class="afe-review-value">${this.selectedAgent?.name || '-'}</span>
        </div>
        ${this.formData.backend ? html`
          <div class="afe-review-item">
            <span class="afe-review-label">Backend</span>
            <span class="afe-review-value">${this.formData.backend}</span>
          </div>
        ` : ''}
        ${this.formData.model ? html`
          <div class="afe-review-item">
            <span class="afe-review-label">Model</span>
            <span class="afe-review-value">${this.formData.model}</span>
          </div>
        ` : ''}
        ${this.formData.systemPrompt ? html`
          <div class="afe-review-item">
            <span class="afe-review-label">System Prompt</span>
            <span class="afe-review-value">${this.formData.systemPrompt.substring(0, 50)}...</span>
          </div>
        ` : ''}
        ${Object.entries(this.formData).filter(([k]) => !['backend', 'model', 'systemPrompt'].includes(k)).map(([key, value]) => html`
          <div class="afe-review-item">
            <span class="afe-review-label">${key}</span>
            <span class="afe-review-value">${typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
          </div>
        `)}
      </div>
      
      <div style="margin-top: 1rem;">
        <button class="afe-btn afe-btn-secondary" style="width: 100%;" @click=${this._saveAsPreset}>
          Save as Preset
        </button>
      </div>
    `;
  }

  _renderStepIndicator() {
    const steps = [
      { num: 1, label: 'Select Agent' },
      { num: 2, label: 'Configure' },
      { num: 3, label: 'Review' }
    ];
    
    return html`
      <div class="afe-wizard-steps">
        ${steps.map(step => html`
          <div class="afe-wizard-step ${this.currentStep === step.num ? 'active' : ''} ${this.currentStep > step.num ? 'completed' : ''}">
            <span class="afe-wizard-step-number">${this.currentStep > step.num ? '✓' : step.num}</span>
            ${step.label}
          </div>
        `)}
      </div>
    `;
  }

  render() {
    return html`
      <div class="afe-wizard">
        <div class="afe-wizard-header">
          <h2>Create Session</h2>
          <button class="afe-wizard-close" @click=${this._close} title="Cancel">✕</button>
        </div>
        ${this._renderStepIndicator()}
        
        ${this.error ? html`<div class="error-message">${this.error}</div>` : ''}
        
        <div class="afe-wizard-content">
          ${this.currentStep === 1 ? this._renderStep1() : ''}
          ${this.currentStep === 2 ? this._renderStep2() : ''}
          ${this.currentStep === 3 ? this._renderStep3() : ''}
        </div>
        
        <div class="afe-wizard-actions">
          ${this.currentStep > 1 
            ? html`<button class="afe-btn afe-btn-secondary" @click=${this._prevStep}>Back</button>`
            : html`<div></div>`
          }
          
          ${this.currentStep < 3 
            ? html`<button class="afe-btn afe-btn-primary" @click=${this._nextStep}>Next</button>`
            : html`<button class="afe-btn afe-btn-primary" @click=${this._createSession}>Create Session</button>`
          }
        </div>
      </div>
    `;
  }
}

customElements.define('afe-wizard', AfeWizard);
