import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

class RxMarblesVisualizer extends LitElement {
    static properties = {
        pipeline: { type: Object },
        chunks: { type: Array },
        theme: { type: String }
    };

    static styles = css`
        :host {
            display: block;
            width: 100%;
            min-height: 400px;
            position: relative;
            overflow: hidden;
            background: var(--bg-color, #f3f4f6);
            color: var(--text-color, #1f2937);
            border-radius: 8px;
        }

        .visualizer-container {
            width: 100%;
            height: 100%;
            position: relative;
        }

        .controls {
            position: absolute;
            top: 10px;
            right: 10px;
            z-index: 100;
            display: flex;
            gap: 5px;
            background: rgba(255, 255, 255, 0.9);
            padding: 8px;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }

        [data-theme="dark"] .controls {
            background: rgba(31, 41, 55, 0.9);
            color: #f9fafb;
        }

        .control-btn {
            padding: 6px 12px;
            border: 1px solid var(--border-color, #e5e7eb);
            border-radius: 4px;
            background: var(--surface-color, #ffffff);
            color: var(--text-color, #1f2937);
            cursor: pointer;
            font-size: 12px;
            transition: all 0.2s ease;
        }

        [data-theme="dark"] .control-btn {
            background: var(--surface-color, #1f2937);
            color: var(--text-color, #f9fafb);
            border-color: var(--border-color, #374151);
        }

        .control-btn:hover {
            background: var(--bg-color, #f3f4f6);
        }

        [data-theme="dark"] .control-btn:hover {
            background: var(--bg-color, #111827);
        }

        .nomnoml-container {
            width: 100%;
            min-height: 400px;
            overflow: auto;
            padding: 20px;
        }

        .nomnoml-container svg {
            max-width: 100%;
            height: auto;
        }

        .legend {
            position: absolute;
            bottom: 10px;
            left: 10px;
            z-index: 100;
            background: rgba(255, 255, 255, 0.9);
            padding: 10px;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            font-size: 12px;
            max-width: 200px;
        }

        [data-theme="dark"] .legend {
            background: rgba(31, 41, 55, 0.9);
            color: #f9fafb;
        }

        .legend-item {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 5px;
        }

        .legend-color {
            width: 20px;
            height: 20px;
            border-radius: 4px;
            border: 1px solid var(--border-color, #e5e7eb);
        }

        .chunk-marker {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            display: inline-block;
            margin-right: 5px;
        }

        .chunk-user { background: #2563eb; }
        .chunk-assistant { background: #f3f4f6; }
        .chunk-system { background: #8b5cf6; }
        .chunk-web { background: #f59e0b; }
        .chunk-trusted { background: #10b981; }
        .chunk-untrusted { background: #ef4444; }

        .loading {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 400px;
            font-size: 18px;
            color: var(--text-secondary, #6b7280);
        }
    `;

    constructor() {
        super();
        this.pipeline = null;
        this.chunks = [];
        this.theme = 'light';
        this.isLoading = true;
        this.nomnomlContainer = null;
        this.isRendering = false;
        this.hasRendered = false;
        this.nomnomlLoaded = false;
    }

    connectedCallback() {
        super.connectedCallback();
        this.setupTheme();
        this.loadNomNoml();
    }

    disconnectedCallback() {
        super.disconnectedCallback();
    }

    setupTheme() {
        const root = document.documentElement;
        this.theme = root.getAttribute('data-theme') || 'light';
        this.setAttribute('data-theme', this.theme);
        
        const themeObserver = new MutationObserver(() => {
            this.theme = root.getAttribute('data-theme') || 'light';
            this.setAttribute('data-theme', this.theme);
            this.updateDiagram();
        });
        
        themeObserver.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    }

    async loadNomNoml() {
        try {
            console.log('Starting to load NomNoml library');
            
            // Check if NomNoml is already loaded
            if (window.nomnoml) {
                console.log('NomNoml already loaded');
                this.nomnomlLoaded = true;
                this.isLoading = false;
                this.updateDiagram();
                return;
            }

            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/nomnoml@1.5.3/dist/nomnoml.min.js';
            script.onload = () => {
                console.log('NomNoml loaded successfully');
                this.nomnomlLoaded = true;
                this.isLoading = false;
                if (this.nomnomlContainer) {
                    this.updateDiagram();
                }
            };
            script.onerror = (event) => {
                console.error('Failed to load NomNoml:', event);
                this.isLoading = false;
                this.renderError('Failed to load NomNoml library');
            };
            script.timeout = 10000; // 10 second timeout
            
            document.head.appendChild(script);
            
            // Timeout to handle cases where script load never completes
            setTimeout(() => {
                if (!this.nomnomlLoaded) {
                    console.error('NomNoml load timeout');
                    this.isLoading = false;
                    this.renderError('NomNoml library timeout');
                }
            }, 10000);
            
        } catch (error) {
            console.error('Error loading NomNoml:', error);
            this.isLoading = false;
            this.renderError(`Error loading NomNoml: ${error.message}`);
        }
    }

    updated(changedProps) {
        console.log('Visualizer updated', changedProps);
        if (!this.hasRendered && !this.isLoading && this.nomnomlLoaded && this.nomnomlContainer) {
            console.log('All conditions met, updating diagram');
            this.updateDiagram();
        }
    }

    render() {
        if (this.isLoading) {
            return html`
                <div class="visualizer-container">
                    <div class="loading">Loading NomNoml diagram...</div>
                </div>
            `;
        }

        return html`
            <div class="visualizer-container">
                <div class="controls">
                    <button class="control-btn" @click="${this.updateDiagram}">Refresh</button>
                </div>
                
                <div class="nomnoml-container" ref="${(el) => {
                    this.nomnomlContainer = el;
                    if (el && !this.isLoading && this.nomnomlLoaded && !this.hasRendered) {
                        console.log('NomNoml container available, rendering diagram');
                        this.updateDiagram();
                    }
                }}"></div>
                
                <div class="legend">
                    <div class="legend-item">
                        <div class="legend-color chunk-user"></div>
                        <span>User Chunk</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color chunk-assistant"></div>
                        <span>Assistant Chunk</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color chunk-system"></div>
                        <span>System Chunk</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color chunk-web"></div>
                        <span>Web Chunk</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color chunk-trusted"></div>
                        <span>Trusted Chunk</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color chunk-untrusted"></div>
                        <span>Untrusted Chunk</span>
                    </div>
                </div>
            </div>
        `;
    }

    updateDiagram() {
        if (this.isLoading || !this.nomnomlLoaded) {
            console.log('Skipping diagram update - loading or NomNoml not available');
            return;
        }

        if (!this.nomnomlContainer) {
            if (!this.isRendering) {
                this.isRendering = true;
                setTimeout(() => {
                    this.isRendering = false;
                    if (!this.hasRendered) {
                        this.updateDiagram();
                    }
                }, 100);
            }
            return;
        }

        if (this.isRendering) {
            return;
        }

        this.isRendering = true;
        try {
            console.log('Rendering diagram with pipeline:', this.pipeline);
            const noml = this.generateNoml();
            console.log('Generated Noml:', noml);
            const svg = window.nomnoml.renderSvg(noml);
            console.log('Rendered SVG length:', svg.length);
            this.nomnomlContainer.innerHTML = svg;
            this.hasRendered = true;
            console.log('Diagram rendered successfully');
        } catch (error) {
            console.error('Error rendering diagram:', error);
            this.renderError(`Error rendering diagram: ${error.message}`);
        } finally {
            this.isRendering = false;
        }
    }

    renderError(message) {
        if (!this.nomnomlContainer) {
            console.warn('Container not available for error rendering');
            return;
        }
        this.nomnomlContainer.innerHTML = `
            <div style="display: flex; justify-content: center; align-items: center; height: 400px; color: #ef4444;">
                ${message}
            </div>
        `;
    }

    generateNoml() {
        if (!this.pipeline) {
            return '[No Pipeline]';
        }

        const pipeline = this.pipeline;
        let noml = `
            #arrowSize: 1
            #bendSize: 0.3
            #direction: right
            #gutter: 10
            #edgeMargin: 0
            #edges: hard
            #background: ${this.theme === 'dark' ? '#1f2937' : '#ffffff'}
            #fill: ${this.theme === 'dark' ? '#374151' : '#f3f4f6'}
            #stroke: ${this.theme === 'dark' ? '#9ca3af' : '#374151'}
            #textColor: ${this.theme === 'dark' ? '#f9fafb' : '#1f2937'}
            #font: Calibri
            #fontSize: 12
            #leading: 1.2
            #title: ${pipeline.name || 'Unknown Pipeline'}
            
            [inputStream] -> `;

        const operators = pipeline.operators || [];
        
        if (operators.length === 0) {
            noml += '[empty] -> [outputStream]';
        } else {
            operators.forEach((op, index) => {
                const opName = this.sanitizeNoml(op.name);
                const opType = this.sanitizeNoml(op.type || '');
                const opDesc = this.sanitizeNoml(op.description || '');
                
                noml += `[${opName}
${opType}
${opDesc}]`;
                
                if (index < operators.length - 1) {
                    noml += ' -> ';
                } else {
                    noml += ' -> [outputStream]';
                }
            });
        }

        return noml;
    }

    sanitizeNoml(text) {
        return text
            .replace(/\\/g, '\\\\')
            .replace(/\]/g, '\\]')
            .replace(/\[/g, '\\[')
            .replace(/\#/g, '\\#');
    }
}

customElements.define('rx-marbles-visualizer', RxMarblesVisualizer);