/**
 * Binary Reference Mode mixin for Lit widgets.
 * Provides deferred-load lifecycle for binary assets (images, audio, files).
 */

/** Size threshold below which assets are auto-fetched on viewport entry (5 MB). */
export const BINARY_SIZE_THRESHOLD = 5120 * 1024;

/**
 * Format a byte count as a human-readable string using the largest applicable unit.
 * Always shows one decimal place, e.g. "1.5 MB", "512.0 B".
 * @param {number} bytes
 * @returns {string}
 */
export function formatByteSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let value = bytes;
  while (index < units.length - 1 && value >= 1024) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

/**
 * BinaryRefMixin — adds deferred-load lifecycle to a Lit element.
 *
 * Reactive properties added:
 *   binaryRef  {Boolean} — when true, widget is in deferred-load mode
 *   byteSize   {Number}  — byte size of the asset
 *   chunkId    {String}  — chunk ID used to fetch binary data
 *   mimeType   {String}  — MIME type of the asset
 *
 * Internal state:
 *   _loadState {'placeholder'|'loading'|'rendered'|'error'|'prompted'}
 *
 * @param {typeof import('https://cdn.jsdelivr.net/npm/lit@3/+esm').LitElement} Base
 */
export const BinaryRefMixin = (Base) => {
  class BinaryRefElement extends Base {
    static properties = {
      // Merge Base's existing static properties
      ...Base.properties,
      // Mixin public properties
      binaryRef:  { type: Boolean },
      byteSize:   { type: Number },
      chunkId:    { type: String },
      mimeType:   { type: String },
      sessionId:  { type: String },
      // Internal reactive state (Lit property, not reflected to attribute)
      _loadState: { type: String, state: true },
    };

    constructor() {
      super();
      this.binaryRef  = false;
      this.byteSize   = 0;
      this.chunkId    = '';
      this.mimeType   = '';
      this.sessionId  = '';
      this._loadState = 'placeholder';
      this._observer  = null;
    }

    connectedCallback() {
      super.connectedCallback();
      if (this.binaryRef === true) {
        this._attachObserver();
      }
    }

    disconnectedCallback() {
      super.disconnectedCallback();
      this._disconnectObserver();
    }

    // ── Observer helpers ────────────────────────────────────────────────────

    _attachObserver() {
      this._disconnectObserver();
      this._observer = new IntersectionObserver((entries) => {
        if (entries.some(e => e.isIntersecting)) {
          this._onViewportEntry();
        }
      });
      this._observer.observe(this);
    }

    _disconnectObserver() {
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
      }
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    _onViewportEntry() {
      // Disconnect immediately so we don't fire again
      this._disconnectObserver();

      if (this.byteSize <= BINARY_SIZE_THRESHOLD) {
        this._loadState = 'loading';
        this._fetchBinary();
      } else {
        this._loadState = 'prompted';
      }
    }

    async _fetchBinary() {
      const token = window.RXCAFE_TOKEN || new URLSearchParams(window.location.search).get('token');
      const url = new URL(`/api/session/${this.sessionId}/chunk/${this.chunkId}/binary`, window.location.origin);
      if (token) url.searchParams.set('token', token);
      try {
        const response = await fetch(url.toString());
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        this._onBinaryLoaded(objectUrl, this.mimeType);
        this._loadState = 'rendered';
      } catch (_err) {
        this._loadState = 'error';
      }
    }

    _retryFetch() {
      this._loadState = 'placeholder';
      this._attachObserver();
    }

    /**
     * Called when binary data has been fetched and a blob URL created.
     * Subclasses override this to render the media element.
     * @param {string} _url       — blob URL
     * @param {string} _mimeType  — MIME type
     */
    _onBinaryLoaded(_url, _mimeType) {
      // Abstract — subclasses override
    }
  }

  return BinaryRefElement;
};
