'use strict';

// The pinned prebuilt Playwright backend mutes headless Chromium by default.
// Remove that default only for a browser routed to our private sound server.
// Keep project launch options and all other Playwright defaults intact.
const Module = require('node:module');
const original = Module._extensions['.js'];
Module._extensions['.js'] = function audioLaunch(module, filename) {
  if (process.env.CARAPA_BROWSER_AUDIO_SERVER &&
      (filename.endsWith('/coreBundle.js') || filename.endsWith('/server/chromium/chromium.js'))) {
    // Compose with other preloaders (including capture sizing) instead of
    // rereading the original file and discarding their source transforms.
    const compile = module._compile;
    module._compile = function compileWithAudio(source, file) {
      return compile.call(this, source.replace(/(['"])--mute-audio\1\s*,/g, ''), file);
    };
    try { return original(module, filename); }
    finally { module._compile = compile; }
  }
  return original(module, filename);
};
