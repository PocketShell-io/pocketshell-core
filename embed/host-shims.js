/**
 * The host surface an embedded JS engine must provide to run the
 * @pocketshell/core bundle — expressed as an idempotent prelude. Browsers,
 * Node and Electron have all of this; bare engines (QuickJS on Android, for
 * one) do not, and this file is the checklist plus a working fallback set.
 *
 * The fallbacks are deliberately minimal: the timers one fails loudly (an
 * engine without an event loop cannot deliver a callback; wire real timers if
 * the embedder has one), while atob/TextDecoder are pure implementations good
 * enough for the contract code's use (OSC 52 clipboard payloads).
 */
(function (g) {
  'use strict';

  if (typeof g.setTimeout !== 'function') {
    // Loud on purpose: a silent never-firing timer hangs an await forever.
    g.setTimeout = function () {
      throw new Error('PocketShellCore host shim: no event loop — provide setTimeout');
    };
  }
  if (typeof g.clearTimeout !== 'function') {
    g.clearTimeout = function () {};
  }

  if (typeof g.atob !== 'function') {
    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    g.atob = function (input) {
      var s = String(input).replace(/[\r\n\t =]/g, '');
      var out = [];
      var buffer = 0;
      var bits = 0;
      for (var i = 0; i < s.length; i++) {
        var v = B64.indexOf(s.charAt(i));
        if (v < 0) throw new Error('InvalidCharacterError: atob');
        buffer = (buffer << 6) | v;
        bits += 6;
        if (bits >= 8) {
          bits -= 8;
          out.push(String.fromCharCode((buffer >> bits) & 0xff));
        }
      }
      return out.join('');
    };
  }

  if (typeof g.TextDecoder === 'function') return;

  g.TextDecoder = function TextDecoder(label) {
    var l = String(label || 'utf-8').toLowerCase();
    if (l !== 'utf-8' && l !== 'utf8') {
      throw new Error('host-shims TextDecoder: only utf-8');
    }
  };

  g.TextDecoder.prototype.decode = function (input) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
    var out = '';
    var i = 0;
    var cont = function (k) {
      return i + k < bytes.length && (bytes[i + k] & 0xc0) === 0x80;
    };
    var bits = function (k) {
      return bytes[i + k] & 0x3f;
    };
    while (i < bytes.length) {
      var b0 = bytes[i];
      var cp = 0xfffd;
      var len = 1;
      if (b0 < 0x80) {
        cp = b0;
      } else if (b0 >= 0xc2 && b0 <= 0xdf && cont(1)) {
        cp = ((b0 & 0x1f) << 6) | bits(1);
        len = 2;
      } else if (b0 >= 0xe0 && b0 <= 0xef && cont(1) && cont(2)) {
        cp = ((b0 & 0x0f) << 12) | (bits(1) << 6) | bits(2);
        len = 3;
      } else if (b0 >= 0xf0 && b0 <= 0xf4 && cont(1) && cont(2) && cont(3)) {
        cp = ((b0 & 0x07) << 18) | (bits(1) << 12) | (bits(2) << 6) | bits(3);
        len = 4;
      }
      out += String.fromCodePoint(cp);
      i += len;
    }
    return out;
  };
})(typeof globalThis === 'object' ? globalThis : this);
