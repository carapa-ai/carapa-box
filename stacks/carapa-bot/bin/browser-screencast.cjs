'use strict';

// Runtime shim for the prebuilt Playwright CLI dashboard. The dashboard owns
// the screencast client, so the controller cannot pass a new size through the
// public dashboard protocol. The viewer adapter publishes the current size in
// a private file and this preload supplies it whenever the dashboard starts a
// screencast.
// The same pinned-bundle preload observes the daemon's selected tab so viewers
// can follow it without issuing page-creating inspection commands.
const fs = require('node:fs');
const Module = require('node:module');
const { patchTabSelection } = require('./browser-tabs.cjs');
const { patchDashboardSocket } = require('./browser-viewer-socket.cjs');

const sizeFile = process.env.CARAPA_BROWSER_VIEWER_SIZE_FILE;
const originalLoad = Module._load;
const originalJsExtension = Module._extensions['.js'];

function readSize() {
  if (!sizeFile) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(sizeFile, 'utf8'));
    if (!Number.isInteger(value?.width) || !Number.isInteger(value?.height) ||
        value.width < 1 || value.height < 1 ||
        value.width > 10_000 || value.height > 10_000)
      return undefined;
    return { width: value.width, height: value.height };
  } catch {
    return undefined;
  }
}

function patchScreencast(Screencast) {
  if (!Screencast?.prototype?.start || Screencast.prototype.start.__carapaSizeShim)
    return;
  const start = Screencast.prototype.start;
  function startWithViewerSize(options = {}) {
    const size = readSize();
    return start.call(this, size ? { ...options, size } : options);
  }
  startWithViewerSize.__carapaSizeShim = true;
  Screencast.prototype.start = startWithViewerSize;
}

function sizeExpression() {
  return `(()=>{try{const value=JSON.parse(require('node:fs').readFileSync(process.env.CARAPA_BROWSER_VIEWER_SIZE_FILE,'utf8'));if(Number.isInteger(value?.width)&&Number.isInteger(value?.height)&&value.width>0&&value.height>0&&value.width<=10000&&value.height<=10000)return{width:value.width,height:value.height}}catch{}return undefined})()`;
}

// The Playwright CLI bundles the dashboard controller into coreBundle.js, so
// there is no separate module prototype to patch in the prebuilt package.
// Rewrite only the dashboard's screencast.start call as it is loaded. The
// generated expression reads the controller-owned file at every start, which
// makes the existing visibility toggle an actual resolution restart.
Module._extensions['.js'] = function loadWithDashboardSize(module, filename) {
  if (filename.endsWith('/coreBundle.js')) {
    let source = fs.readFileSync(filename, 'utf8');
    source = patchTabSelection(source);
    source = patchDashboardSocket(source);
    // The daemon shares one capture between recording and live viewers.
    // Upstream only honors the first client's size (usually the recording).
    // Grow capture when a later viewer requests more pixels; the encoder keeps
    // its own output dimensions and existing clients keep receiving frames.
    source = source.replace(
      'this._startScreencast(client.size, client.quality, client.fps);\n        } else if (this._lastFrame)',
      `this._startScreencast(client.size, client.quality, client.fps);
        } else if (client.size && this._size &&
                   (client.size.width > this._size.width || client.size.height > this._size.height)) {
          const size = { width: Math.max(client.size.width, this._size.width),
                         height: Math.max(client.size.height, this._size.height) };
          this._stopScreencast();
          this._startScreencast(size, client.quality, client.fps);
        } else if (this._lastFrame)`);
    const marker = 'screencast.start({';
    let cursor = 0;
    let markerIndex;
    let patched = false;
    while (sizeFile && (markerIndex = source.indexOf(marker, cursor)) !== -1) {
      // Dashboard streaming has an onFrame callback. Video recording also
      // uses page.screencast.start(), but must retain its own configured size.
      if (source.slice(markerIndex, markerIndex + 2_000).includes('onFrame')) {
        source = source.slice(0, markerIndex + marker.length) +
          `size:${sizeExpression()},` + source.slice(markerIndex + marker.length);
        patched = true;
        cursor = markerIndex + marker.length + 1;
      } else {
        cursor = markerIndex + marker.length;
      }
    }
    if (patched)
      source = source.replace(/size:\s*\{\s*width:\s*1280\s*,\s*height:\s*800\s*\},?/g, '');
    module._compile(source, filename);
    return;
  }
  return originalJsExtension(module, filename);
};

Module._load = function loadWithScreencastShim(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  // The prebuilt package exports this class from client/screencast. Keeping
  // this capability-based check also tolerates minor package path changes.
  patchScreencast(loaded?.Screencast);
  return loaded;
};
