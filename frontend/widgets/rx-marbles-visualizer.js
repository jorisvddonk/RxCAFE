import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

class RxMarblesVisualizer extends LitElement {
    static properties = {
        pipeline: { type: Object },
        chunks: { type: Array },
        theme: { type: String },
        scale: { type: Number },
        panX: { type: Number },
        panY: { type: Number }
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

        .canvas-wrapper {
            width: 100%;
            height: 100%;
            overflow: hidden;
            cursor: grab;
            position: relative;
        }

        .canvas-wrapper:active {
            cursor: grabbing;
        }

        .nomnoml-container {
            width: 100%;
            min-height: 400px;
            padding: 20px;
            transform-origin: center center;
            transition: transform 0.1s ease-out;
        }

        .nomnoml-container svg {
            max-width: none;
            height: auto;
        }

        .zoom-info {
            position: absolute;
            bottom: 10px;
            right: 10px;
            z-index: 100;
            background: rgba(255, 255, 255, 0.9);
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
            color: var(--text-secondary, #6b7280);
        }

        [data-theme="dark"] .zoom-info {
            background: rgba(31, 41, 55, 0.9);
            color: #9ca3af;
        }

        .loading {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 400px;
            color: var(--text-secondary, #6b7280);
        }

        .error {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 400px;
            color: #ef4444;
            padding: 20px;
            text-align: center;
        }
    `;

    constructor() {
        super();
        this.pipeline = null;
        this.chunks = [];
        this.theme = 'light';
        this.nomnomlContainer = null;
        this.hasRendered = false;
        this.isRendering = false;
        this.scale = 1;
        this.panX = 0;
        this.panY = 0;
        this.isDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;
    }

    connectedCallback() {
        super.connectedCallback();
        this.setupTheme();
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

    updated(changedProps) {
        const pipelineChanged = changedProps.has('pipeline') || changedProps.has('chunks');
        this.nomnomlContainer = this.renderRoot.querySelector('.nomnoml-container');
        
        if (this.nomnomlContainer && pipelineChanged) {
            this.updateDiagram();
        }
    }

    render() {
        if (!this.pipeline) {
            return html`
                <div class="visualizer-container">
                    <div class="error">No pipeline data available</div>
                </div>
            `;
        }

        const transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
        
        return html`
            <div class="visualizer-container">
                <div class="controls">
                    <button class="control-btn" @click="${() => this.zoomIn()}">+</button>
                    <button class="control-btn" @click="${() => this.zoomOut()}">-</button>
                    <button class="control-btn" @click="${() => this.resetView()}">Reset</button>
                    <button class="control-btn" @click="${this.updateDiagram}">Refresh</button>
                </div>
                
                <div class="canvas-wrapper" 
                     @wheel="${this.handleWheel}"
                     @mousedown="${this.handleMouseDown}"
                     @mousemove="${this.handleMouseMove}"
                     @mouseup="${this.handleMouseUp}"
                     @mouseleave="${this.handleMouseUp}">
                    <div class="nomnoml-container" style="transform: ${transform}"></div>
                </div>
                
                <div class="zoom-info">${Math.round(this.scale * 100)}%</div>
            </div>
        `;
    }

    updateDiagram() {
        if (!window.nomnoml) {
            this.renderError('NomNoml library not loaded');
            return;
        }

        this.nomnomlContainer = this.renderRoot.querySelector('.nomnoml-container');
        if (!this.nomnomlContainer || this.isRendering) {
            return;
        }

        this.isRendering = true;
        try {
            const noml = this.generateNoml();
            const svg = window.nomnoml.renderSvg(noml);
            this.nomnomlContainer.innerHTML = svg;
            this.hasRendered = true;
        } catch (error) {
            console.error('[NOMNOML] Error:', error);
            this.renderError(`Error rendering diagram: ${error.message}`);
        } finally {
            this.isRendering = false;
        }
    }

    renderError(message) {
        if (this.nomnomlContainer) {
            this.nomnomlContainer.innerHTML = `<div class="error">${message}</div>`;
        }
    }

    generateNoml() {
        if (!this.pipeline) {
            return '[No Pipeline]';
        }

        const pipeline = this.pipeline;
        
        // Config directives (each on its own line)
        const config = [
            '#arrowSize: 1',
            '#bendSize: 0.3',
            '#direction: down',
            '#gutter: 10',
            '#edgeMargin: 0',
            '#edges: hard',
            `#background: ${this.theme === 'dark' ? '#1f2937' : '#ffffff'}`,
            `#fill: ${this.theme === 'dark' ? '#374151' : '#f3f4f6'}`,
            `#stroke: ${this.theme === 'dark' ? '#9ca3af' : '#374151'}`,
            `#textColor: ${this.theme === 'dark' ? '#f9fafb' : '#1f2937'}`,
            '#font: Calibri',
            '#fontSize: 12',
            '#leading: 1.2',
            `#title: ${(pipeline.name || 'Unknown Pipeline').replace(/[[\]#|]/g, ' ')}`
        ];

        // Build the pipeline diagram
        const nodes = ['[inputStream]'];
        const operators = pipeline.operators || [];
        
        if (operators.length === 0) {
            nodes.push('[empty]');
        } else {
            operators.forEach((op) => {
                const parts = [op.name, op.type || '', op.description || ''].filter(Boolean);
                nodes.push(`[${parts.join(' - ')}]`);
            });
        }
        
        nodes.push('[outputStream]');
        
        // Config on separate lines, then the diagram
        const diagram = [];
        for (let i = 0; i < nodes.length - 1; i++) {
            diagram.push(nodes[i] + ' -> ' + nodes[i + 1]);
        }
        return config.join('\n') + '\n\n' + diagram.join('\n');
    }

    zoomIn() {
        this.scale = Math.min(this.scale * 1.2, 5);
    }

    zoomOut() {
        this.scale = Math.max(this.scale / 1.2, 0.2);
    }

    resetView() {
        this.scale = 1;
        this.panX = 0;
        this.panY = 0;
    }

    handleWheel(e) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        this.scale = Math.max(0.2, Math.min(5, this.scale * delta));
    }

    handleMouseDown(e) {
        this.isDragging = true;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
    }

    handleMouseMove(e) {
        if (!this.isDragging) return;
        e.preventDefault();
        const dx = e.clientX - this.lastMouseX;
        const dy = e.clientY - this.lastMouseY;
        this.panX += dx;
        this.panY += dy;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
    }

    handleMouseUp() {
        this.isDragging = false;
    }
}

customElements.define('rx-marbles-visualizer', RxMarblesVisualizer);
