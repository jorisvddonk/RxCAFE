import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = join(__dirname, '..', 'frontend');

export function getFrontendHtml(token?: string): string {
  try {
    let html = readFileSync(join(FRONTEND_DIR, 'index.html'), 'utf-8');
    if (token) {
      const tokenScript = `<script>window.RXCAFE_TOKEN = "${token}";</script>`;
      html = html.replace('</head>', `${tokenScript}</head>`);
    }
    return html;
  } catch {
    return `<!DOCTYPE html>
<html>
<head><title>RXCAFE Chat</title></head>
<body>
<h1>RXCAFE Chat</h1>
<p>Frontend not found.</p>
</body>
</html>`;
  }
}

export function getFrontendJs(): string {
  try {
    return readFileSync(join(FRONTEND_DIR, 'app.js'), 'utf-8');
  } catch {
    return 'console.error("Frontend JS not found");';
  }
}

export function getFrontendCss(): string {
  try {
    return readFileSync(join(FRONTEND_DIR, 'styles.css'), 'utf-8');
  } catch {
    return '';
  }
}

export function getManifest(): string {
  try {
    return readFileSync(join(FRONTEND_DIR, 'manifest.json'), 'utf-8');
  } catch {
    return '{}';
  }
}

export function getServiceWorker(): string {
  try {
    return readFileSync(join(FRONTEND_DIR, 'sw.js'), 'utf-8');
  } catch {
    return '';
  }
}

export function getIcon(size: number): Buffer | null {
  try {
    return readFileSync(join(FRONTEND_DIR, `icon-${size}.png`));
  } catch {
    return null;
  }
}

export function getIconSvg(): string {
  try {
    return readFileSync(join(FRONTEND_DIR, 'icon.svg'), 'utf-8');
  } catch {
    return '<svg xmlns="http://www.w3.org/2000/svg"/>';
  }
}

export function getWidgetFile(filename: string): string | null {
  try {
    return readFileSync(join(FRONTEND_DIR, 'widgets', filename), 'utf-8');
  } catch {
    return null;
  }
}

export function getWidgetCss(): string {
  try {
    return readFileSync(join(FRONTEND_DIR, 'widgets', 'styles.css'), 'utf-8');
  } catch {
    return '';
  }
}

export function getDiceCss(): string {
  try {
    return readFileSync(join(FRONTEND_DIR, 'css', 'dice.css'), 'utf-8');
  } catch {
    return '';
  }
}

export function getJsFile(filename: string): string | null {
  try {
    return readFileSync(join(FRONTEND_DIR, 'js', filename), 'utf-8');
  } catch {
    return null;
  }
}

export interface FrontendHandler {
  getHtml: (token?: string) => string;
  getJs: () => string;
  getCss: () => string;
  getManifest: () => string;
  getServiceWorker: () => string;
  getIcon: (size: number) => Buffer | null;
  getIconSvg: () => string;
  getWidgetFile: (filename: string) => string | null;
  getWidgetCss: () => string;
  getJsFile: (filename: string) => string | null;
}

export const frontendHandler: FrontendHandler = {
  getHtml: getFrontendHtml,
  getJs: getFrontendJs,
  getCss: getFrontendCss,
  getManifest: getManifest,
  getServiceWorker: getServiceWorker,
  getIcon: getIcon,
  getIconSvg: getIconSvg,
  getWidgetFile: getWidgetFile,
  getWidgetCss: getWidgetCss,
  getJsFile: getJsFile
};
