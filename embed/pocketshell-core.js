"use strict";
var PocketShellCore = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/index.ts
  var index_exports = {};
  __export(index_exports, {
    APLEXER_LIST_SORT: () => APLEXER_LIST_SORT,
    AplexerCore: () => AplexerCore,
    BP_END: () => BP_END,
    BP_START: () => BP_START,
    GOOGLE_CLIENT_ID: () => GOOGLE_CLIENT_ID,
    HELPER_BASELINE_KINDS: () => HELPER_BASELINE_KINDS,
    HELPER_VERSION_WITHOUT_GROK: () => HELPER_VERSION_WITHOUT_GROK,
    KIND_LABELS: () => KIND_LABELS,
    LAUNCHABLE_KINDS: () => LAUNCHABLE_KINDS,
    LOOPBACK_HOST: () => LOOPBACK_HOST,
    MAX_PORT: () => MAX_PORT,
    PASTE_GAP_MS: () => PASTE_GAP_MS,
    SUBMIT_KEY: () => SUBMIT_KEY,
    SYNC_API_URL: () => SYNC_API_URL,
    SYNC_SLOT: () => SYNC_SLOT,
    USER_BIN_DIRS: () => USER_BIN_DIRS,
    USER_BIN_PATH: () => USER_BIN_PATH,
    agentKindFromEngine: () => agentKindFromEngine,
    aliasesToAutoCheck: () => aliasesToAutoCheck,
    aplexerAckCommand: () => aplexerAckCommand,
    aplexerAttachCommand: () => aplexerAttachCommand,
    aplexerKillCommand: () => aplexerKillCommand,
    aplexerProbeCommand: () => aplexerProbeCommand,
    aplexerRecordToSummary: () => aplexerRecordToSummary,
    aplexerRenameCommand: () => aplexerRenameCommand,
    aplexerSelector: () => aplexerSelector,
    aplexerSnapshotCommand: () => aplexerSnapshotCommand,
    aplexerStartCommand: () => aplexerStartCommand,
    aplexerWarningsCommand: () => aplexerWarningsCommand,
    assembleSyncSet: () => assembleSyncSet,
    buildHosts: () => buildHosts,
    buildLaunchCommand: () => buildLaunchCommand,
    byOldestCreated: () => byOldestCreated,
    bytesToBase64: () => bytesToBase64,
    coerceHostEntries: () => coerceHostEntries,
    commandsFor: () => commandsFor,
    composerAgentKind: () => composerAgentKind,
    composerTiming: () => composerTiming,
    decodeOsc52SetClipboard: () => decodeOsc52SetClipboard,
    decodePublicKeyBlob: () => decodePublicKeyBlob,
    deliverPayload: () => deliverPayload,
    entryTypeOf: () => entryTypeOf,
    filterCommands: () => filterCommands,
    filteredCommands: () => filteredCommands,
    formatBytes: () => formatBytes,
    formatMb: () => formatMb,
    frameForPaste: () => frameForPaste,
    insertionTextFor: () => insertionTextFor,
    isAplexerAckNotFound: () => isAplexerAckNotFound,
    isAplexerNotFound: () => isAplexerNotFound,
    isAplexerSessionLive: () => isAplexerSessionLive,
    isAplexerStartRefusal: () => isAplexerStartRefusal,
    isAplexerUnknownFlag: () => isAplexerUnknownFlag,
    isLaunchableKind: () => isLaunchableKind,
    kindNeedsNewerHelper: () => kindNeedsNewerHelper,
    kindUnavailableReason: () => kindUnavailableReason,
    knownHostsToken: () => knownHostsToken,
    launchBlocker: () => launchBlocker,
    needsBracketedPaste: () => needsBracketedPaste,
    oversizeMessage: () => oversizeMessage,
    parseAplexerSnapshot: () => parseAplexerSnapshot,
    parseAplexerWarnings: () => parseAplexerWarnings,
    parseDirectiveLine: () => parseDirectiveLine,
    parseProfileRows: () => parseProfileRows,
    parseSingleAplexerRecord: () => parseSingleAplexerRecord,
    parseSyncPayload: () => parseSyncPayload,
    pathAwareCommand: () => pathAwareCommand,
    profileFlagName: () => profileFlagName,
    profilesFor: () => profilesFor,
    sendRoute: () => sendRoute,
    serializeSyncPayload: () => serializeSyncPayload,
    shellEscapeInsideSingleQuotes: () => shellEscapeInsideSingleQuotes,
    shellQuote: () => shellQuote,
    shellQuoteRemotePath: () => shellQuoteRemotePath,
    supportsProfiles: () => supportsProfiles,
    supportsSkipPermissions: () => supportsSkipPermissions,
    toDirEntry: () => toDirEntry,
    toFileStat: () => toFileStat,
    verifyHostKeyPin: () => verifyHostKeyPin,
    withTimeout: () => withTimeout
  });

  // src/net.ts
  var MAX_PORT = 65535;
  var LOOPBACK_HOST = "127.0.0.1";

  // src/byteSize.ts
  function formatBytes(size) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
    return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }
  function formatMb(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1);
  }
  function oversizeMessage(size, maxBytes, subject) {
    return `${subject} is ${formatMb(size)} MB; the limit is ${formatMb(maxBytes)} MB`;
  }

  // src/shellQuote.ts
  function shellEscapeInsideSingleQuotes(value) {
    return value.replace(/'/g, "'\\''");
  }
  function shellQuote(value) {
    return `'${shellEscapeInsideSingleQuotes(value)}'`;
  }
  function shellQuoteRemotePath(value) {
    const trimmed = value.trim() || "~";
    if (trimmed === "~" || trimmed === "$HOME") return "$HOME";
    if (trimmed.startsWith("~/")) return `$HOME/${shellQuote(trimmed.slice(2))}`;
    if (trimmed.startsWith("$HOME/")) return `$HOME/${shellQuote(trimmed.slice(6))}`;
    return shellQuote(trimmed);
  }

  // src/userBinPath.ts
  var USER_BIN_DIRS = ["$HOME/.local/bin", "$HOME/bin", "$HOME/.cargo/bin"];
  var USER_BIN_PATH = USER_BIN_DIRS.join(":");

  // src/sync.ts
  function coerceHostEntries(raw) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry;
      const name = typeof e["name"] === "string" ? e["name"].trim() : "";
      const hostname = typeof e["hostname"] === "string" ? e["hostname"].trim() : "";
      if (name === "" || hostname === "" || /\s/.test(name) || /\s/.test(hostname)) continue;
      out.push({
        name,
        hostname,
        port: typeof e["port"] === "number" && Number.isInteger(e["port"]) && e["port"] > 0 && e["port"] <= 65535 ? e["port"] : 22,
        user: typeof e["user"] === "string" ? e["user"] : "",
        identityFile: typeof e["identityFile"] === "string" && e["identityFile"] !== "" ? e["identityFile"] : null,
        proxyJump: typeof e["proxyJump"] === "string" && e["proxyJump"] !== "" ? e["proxyJump"] : null,
        forwardAgent: e["forwardAgent"] === true,
        localForwards: coerceForwards(e["localForwards"], "local"),
        remoteForwards: coerceForwards(e["remoteForwards"], "remote"),
        fromConfig: true
      });
    }
    return out;
  }
  function coerceForwards(raw, kind) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const f = entry;
      if (typeof f["listenPort"] !== "number" || typeof f["destPort"] !== "number") continue;
      if (typeof f["destHost"] !== "string" || f["destHost"] === "") continue;
      out.push({
        kind,
        listenHost: typeof f["listenHost"] === "string" ? f["listenHost"] : "",
        listenPort: f["listenPort"],
        destHost: f["destHost"],
        destPort: f["destPort"]
      });
    }
    return out;
  }

  // src/syncConfig.ts
  var GOOGLE_CLIENT_ID = "1035162854462-nos4fptbf2psbkp8ljd8tjem1psnekvt.apps.googleusercontent.com";
  var SYNC_API_URL = "https://a7sota2qic.execute-api.eu-west-1.amazonaws.com";
  var SYNC_SLOT = "main";

  // src/syncMerge.ts
  function assembleSyncSet(local, remote, checked) {
    const localByName = new Map(local.map((host) => [host.name, host]));
    const remoteByName = new Map(remote.map((host) => [host.name, host]));
    const hosts = [];
    const seen = /* @__PURE__ */ new Set();
    for (const alias of checked) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      const entry = localByName.get(alias) ?? remoteByName.get(alias);
      if (entry) hosts.push(entry);
    }
    return hosts;
  }
  function aliasesToAutoCheck(remote, checked, localAliases) {
    const known = new Set(checked);
    const local = new Set(localAliases);
    return remote.map((host) => host.name).filter((name) => !known.has(name) && !local.has(name));
  }
  function serializeSyncPayload(hosts) {
    return JSON.stringify({ hosts });
  }
  function parseSyncPayload(plaintext) {
    try {
      const parsed = JSON.parse(plaintext);
      if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed["hosts"])) {
        return [];
      }
      const out = [];
      for (const entry of parsed["hosts"]) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry;
        const name = e["name"];
        const hostname = e["hostname"];
        if (typeof name !== "string" || name.trim() === "" || typeof hostname !== "string" || hostname.trim() === "") {
          continue;
        }
        out.push(e);
      }
      return out;
    } catch {
      return [];
    }
  }

  // src/sshConfigCore.ts
  var DEFAULT_PORT = 22;
  function parseDirectiveLine(raw, lineNo) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return null;
    const match = /^(\S+)\s*(.*)$/.exec(trimmed);
    if (!match || match[1] === void 0) return null;
    return { key: match[1].toLowerCase(), value: (match[2] ?? "").trim(), line: lineNo };
  }
  function buildHosts(directives) {
    const hosts = [];
    let current = null;
    const pushCurrent = () => {
      if (!current) return;
      for (const name of current.names) {
        hosts.push(finalizeHost(current, name));
      }
      current = null;
    };
    for (const d of directives) {
      if (d.key === "host") {
        pushCurrent();
        current = {
          names: d.value.split(/\s+/).filter(Boolean),
          localForwards: [],
          remoteForwards: [],
          forwardAgent: false
        };
        continue;
      }
      if (!current) continue;
      switch (d.key) {
        case "hostname":
          current.hostname = d.value;
          break;
        case "port":
          current.port = parsePort(d.value);
          break;
        case "user":
          current.user = d.value;
          break;
        case "identityfile":
          current.identityFile = d.value;
          break;
        case "proxyjump":
          current.proxyJump = d.value;
          break;
        case "forwardagent":
          current.forwardAgent = d.value.toLowerCase() === "yes";
          break;
        case "localforward":
          current.localForwards?.push(parseForward(d.value, "local"));
          break;
        case "remoteforward":
          current.remoteForwards?.push(parseForward(d.value, "remote"));
          break;
        default:
          break;
      }
    }
    pushCurrent();
    return hosts;
  }
  function finalizeHost(partial, name) {
    return {
      name,
      hostname: partial.hostname ?? name,
      port: partial.port ?? DEFAULT_PORT,
      user: partial.user ?? "",
      // ssh defaults to current user; left blank for the UI
      identityFile: partial.identityFile ?? null,
      proxyJump: partial.proxyJump ?? null,
      forwardAgent: partial.forwardAgent ?? false,
      localForwards: partial.localForwards ?? [],
      remoteForwards: partial.remoteForwards ?? [],
      fromConfig: true
    };
  }
  function parsePort(value) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 && n <= MAX_PORT ? n : DEFAULT_PORT;
  }
  function parseForward(value, kind) {
    const tokens = value.split(/\s+/).filter(Boolean);
    const [listenPart, destPart] = tokens;
    const listen = splitHostPort(listenPart ?? value);
    if (destPart) {
      const dest = splitHostPort(destPart);
      return {
        kind,
        listenHost: listen.host,
        listenPort: listen.port,
        destHost: dest.host,
        destPort: dest.port
      };
    }
    return {
      kind,
      listenHost: listen.host,
      listenPort: listen.port,
      destHost: "",
      destPort: 0
    };
  }
  function splitHostPort(part) {
    if (part.startsWith("[")) {
      const close = part.indexOf("]");
      const host2 = part.slice(1, close);
      const portPart = part.slice(close + 2);
      return { host: host2, port: Number.parseInt(portPart, 10) || 0 };
    }
    const colon = part.lastIndexOf(":");
    if (colon < 0) return { host: LOOPBACK_HOST, port: Number.parseInt(part, 10) || 0 };
    const host = part.slice(0, colon);
    const port = Number.parseInt(part.slice(colon + 1), 10) || 0;
    return { host: host || LOOPBACK_HOST, port };
  }

  // src/knownHostsCore.ts
  function knownHostsToken(host, port = 22) {
    return port === 22 ? host : `[${host}]:${port}`;
  }
  function verifyHostKeyPin(pin, keyType, keyB64) {
    if (pin === void 0) return "unknown";
    if (pin.keyType !== keyType || pin.keyB64 !== keyB64) return "mismatch";
    return "trusted";
  }
  function decodePublicKeyBlob(blob) {
    const len = blob.length >= 4 ? (blob[0] << 24 | blob[1] << 16 | blob[2] << 8 | blob[3]) >>> 0 : 0;
    if (len === 0 || blob.length < 4 + len) return { keyType: "unknown", keyB64: bytesToBase64(blob) };
    let keyType = "";
    for (let i = 4; i < 4 + len; i++) keyType += String.fromCharCode(blob[i]);
    return { keyType, keyB64: bytesToBase64(blob) };
  }
  function bytesToBase64(bytes) {
    const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const has1 = i + 1 < bytes.length;
      const has2 = i + 2 < bytes.length;
      const b1 = has1 ? bytes[i + 1] : 0;
      const b2 = has2 ? bytes[i + 2] : 0;
      out += table[b0 >> 2];
      out += table[(b0 & 3) << 4 | b1 >> 4];
      out += has1 ? table[(b1 & 15) << 2 | b2 >> 6] : "=";
      out += has2 ? table[b2 & 63] : "=";
    }
    return out;
  }

  // src/osc52.ts
  var MAX_PAYLOAD_CHARS = 1e6;
  function decodeOsc52SetClipboard(data) {
    const sep = data.indexOf(";");
    if (sep === -1) return null;
    const selector = data.slice(0, sep);
    const payload = data.slice(sep + 1);
    if (!/^([cps]?|\d{0,4})$/.test(selector)) return null;
    if (payload === "") return null;
    if (payload.length > MAX_PAYLOAD_CHARS) return null;
    let base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4 !== 0) base64 += "=";
    let binary;
    try {
      binary = atob(base64);
    } catch {
      return null;
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  // src/sftpCore.ts
  function entryTypeOf(longname, attrs) {
    if (longname && longname.length > 0) {
      if (longname.startsWith("d")) return "dir";
      if (longname.startsWith("l")) return "symlink";
      if (longname.startsWith("-")) return "file";
    }
    try {
      if (typeof attrs.isDirectory === "function" && attrs.isDirectory()) return "dir";
      if (typeof attrs.isSymbolicLink === "function" && attrs.isSymbolicLink()) return "symlink";
      if (typeof attrs.isFile === "function" && attrs.isFile()) return "file";
    } catch {
    }
    return "other";
  }
  function toDirEntry(attrs, name) {
    const mode = typeof attrs.mode === "number" ? attrs.mode : 0;
    return {
      name: name ?? "",
      longname: attrs.longname ?? "",
      type: entryTypeOf(attrs.longname, attrs),
      size: typeof attrs.size === "number" ? attrs.size : 0,
      modifyTime: (typeof attrs.mtime === "number" ? attrs.mtime : 0) * 1e3,
      accessTime: (typeof attrs.atime === "number" ? attrs.atime : 0) * 1e3,
      rights: {
        user: modeToRwx(mode >> 6 & 7),
        group: modeToRwx(mode >> 3 & 7),
        other: modeToRwx(mode & 7)
      },
      owner: typeof attrs.uid === "number" ? attrs.uid : 0,
      group: typeof attrs.gid === "number" ? attrs.gid : 0
    };
  }
  function toFileStat(attrs) {
    return {
      type: entryTypeOf(attrs.longname, attrs),
      size: typeof attrs.size === "number" ? attrs.size : 0,
      modifyTime: (typeof attrs.mtime === "number" ? attrs.mtime : 0) * 1e3,
      accessTime: (typeof attrs.atime === "number" ? attrs.atime : 0) * 1e3
    };
  }
  function modeToRwx(m) {
    return (m & 4 ? "r" : "-") + (m & 2 ? "w" : "-") + (m & 1 ? "x" : "-");
  }

  // src/aplexer.ts
  var APLEXER_LIST_SORT = "accessed";
  function isAplexerSessionLive(record) {
    if (record.worker_alive === false) return false;
    switch (record.phase) {
      case "starting":
      case "running":
      case "exiting":
        return true;
      default:
        return false;
    }
  }
  function aplexerSelector(workspace, tag) {
    return `${workspace}:${tag}`;
  }
  function aplexerAttachCommand(options) {
    const { id, workspace, tag } = options;
    const workspaceArg = workspace != null && workspace.trim() !== "" ? shellQuoteRemotePath(workspace) : shellQuote(workspace ?? "");
    const target = id != null && id !== "" ? shellQuote(id) : `--workspace ${workspaceArg} --tag ${shellQuote(tag ?? "")}`;
    const label = tag ?? workspace ?? id ?? "session";
    const failure = "\\n[PocketShell] could not join session %s. The aplexer session is gone, or `a` is not installed on this host any more.\\n";
    return `( PATH="${USER_BIN_PATH}:$PATH"; a attach ${target} ) || printf '${failure}' ${shellQuote(label)}; exit`;
  }

  // src/aplexerCommands.ts
  function pathAwareCommand(command) {
    return `/bin/sh -lc 'export PATH="${USER_BIN_PATH}:$PATH"; ${shellEscapeInsideSingleQuotes(command)}'`;
  }
  function aplexerProbeCommand() {
    return "command -v a";
  }
  function aplexerSnapshotCommand(sort) {
    return sort === void 0 ? "a snapshot --json" : `a snapshot --json --sort ${sort}`;
  }
  function isAplexerUnknownFlag(stderr) {
    return /\bunexpected argument\b|\bunrecognized\b|\bunknown option\b/i.test(stderr);
  }
  function aplexerStartCommand(workspace, tag) {
    return `a start --workspace ${shellQuoteRemotePath(workspace)} --tag ${shellQuote(tag)} --json`;
  }
  function isAplexerStartRefusal(exitCode, stderr) {
    return exitCode !== 0 && /already belongs to/i.test(stderr);
  }
  function aplexerKillCommand(id) {
    return `a kill ${shellQuote(id)} --json`;
  }
  function isAplexerNotFound(exitCode, stderr) {
    return exitCode !== 0 && /no matching session/i.test(stderr);
  }
  function aplexerRenameCommand(id, tag) {
    return `a rename ${shellQuote(id)} --tag ${shellQuote(tag)}`;
  }
  function aplexerWarningsCommand() {
    return "a warnings --json";
  }
  function aplexerAckCommand(target) {
    return target === void 0 ? "a ack" : `a ack ${shellQuote(target)}`;
  }
  function isAplexerAckNotFound(exitCode, stderr) {
    return exitCode !== 0 && /no matching unacknowledged warning/i.test(stderr);
  }

  // src/aplexerParsers.ts
  function byOldestCreated(records) {
    return [...records].sort((a, b) => a.created_at_ms - b.created_at_ms);
  }
  function parseAplexerSnapshot(stdout) {
    let parsed;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out = [];
    for (const row of parsed) {
      const record = parseAplexerRecord(row);
      if (record) out.push(record);
    }
    return out;
  }
  function parseAplexerRecord(row) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
    const doc = row;
    const id = doc["id"];
    const workspace = doc["workspace"];
    const tag = doc["tag"];
    if (typeof id !== "string" || id.length === 0) return null;
    if (typeof workspace !== "string" || workspace.length === 0) return null;
    if (typeof tag !== "string" || tag.length === 0) return null;
    const phase = typeof doc["phase"] === "string" ? doc["phase"] : "";
    const workerAlive = doc["worker_alive"];
    if (workerAlive === false) return null;
    if (workerAlive !== true && isTerminalPhase(phase)) return null;
    const createdMs = typeof doc["created_at_ms"] === "number" ? doc["created_at_ms"] : NaN;
    const activityMs = typeof doc["last_activity_ms"] === "number" ? doc["last_activity_ms"] : NaN;
    const cwdRaw = doc["cwd"];
    const cwd = typeof cwdRaw === "string" && cwdRaw.length > 0 ? cwdRaw : null;
    const engineRaw = doc["engine"];
    const engine = typeof engineRaw === "string" ? engineRaw : "";
    const profileRaw = doc["profile"];
    const profile = typeof profileRaw === "string" ? profileRaw : null;
    return {
      id,
      workspace,
      tag,
      engine,
      ...profile ? { profile } : {},
      ...cwd ? { cwd } : {},
      phase,
      ...typeof workerAlive === "boolean" ? { worker_alive: workerAlive } : {},
      created_at_ms: Number.isFinite(createdMs) ? createdMs : 0,
      ...Number.isFinite(activityMs) ? { last_activity_ms: activityMs } : {}
    };
  }
  function isTerminalPhase(phase) {
    return phase === "exited" || phase === "failed";
  }
  function agentKindFromEngine(engine) {
    switch (engine?.trim().toLowerCase()) {
      case "claude":
        return "claude";
      case "codex":
        return "codex";
      case "opencode":
        return "opencode";
      case "grok":
        return "grok";
      case "shell":
        return "shell";
      default:
        return null;
    }
  }
  function parseAplexerWarnings(stdout) {
    let parsed;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out = [];
    for (const row of parsed) {
      if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
      const doc = row;
      const session = doc["session"];
      const tag = doc["tag"];
      const kind = doc["kind"];
      if (typeof session !== "string" || session.length === 0) continue;
      if (typeof tag !== "string" || tag.length === 0) continue;
      if (kind !== "oom" && kind !== "crash") continue;
      const createdMs = doc["created_at_ms"];
      if (typeof createdMs !== "number" || !Number.isFinite(createdMs)) continue;
      const workspace = doc["workspace"];
      const engine = doc["engine"];
      const detail = doc["detail"];
      out.push({
        session,
        tag,
        kind,
        created_at_ms: createdMs,
        ...typeof workspace === "string" ? { workspace } : { workspace: "" },
        ...typeof engine === "string" ? { engine } : { engine: "" },
        ...typeof detail === "string" ? { detail } : { detail: "" }
      });
    }
    return out;
  }
  function parseSingleAplexerRecord(stdout) {
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(stdout.slice(start, end + 1));
      const records = parseAplexerSnapshot(JSON.stringify([parsed]));
      return records.at(0) ?? null;
    } catch {
      return null;
    }
  }
  function aplexerRecordToSummary(record) {
    return {
      name: record.tag,
      created: Math.floor(record.created_at_ms / 1e3),
      activity: record.last_activity_ms != null ? Math.floor(record.last_activity_ms / 1e3) : Math.floor(record.created_at_ms / 1e3),
      attached: false,
      path: record.workspace || record.cwd || null,
      agentKind: agentKindFromEngine(record.engine),
      backend: "aplexer",
      workspace: record.workspace,
      tag: record.tag,
      aplexerId: record.id,
      ...record.profile ? { profile: record.profile } : {},
      ...record.phase ? { aplexerPhase: record.phase } : {}
    };
  }

  // src/aplexerClientCore.ts
  var AplexerCore = class {
    constructor(transport, onListed) {
      __publicField(this, "transport", transport);
      __publicField(this, "onListed", onListed);
      /**
       * `a` present on this host. Null means "not asked yet"; false means "asked
       * and it is absent". Remembering the negative matters as much as the
       * positive: a host without aplexer must pay one probe per CONNECTION, not
       * one per five-second poll tick.
       */
      __publicField(this, "available", null);
      /**
       * `--sort` support, same discipline as the availability probe: true after
       * one sorted snapshot answered, false after the CLI refused the flag (an
       * old host — every tick then goes straight to the unsorted exec), unknown
       * until one of those happens.
       */
      __publicField(this, "sortSupported", null);
    }
    /** Forget cached per-host state. Call on disconnect. */
    evict() {
      this.available = null;
      this.sortSupported = null;
    }
    /**
     * Is `a` installed on this host? Cached, never throws — a host that
     * cannot be asked is a host without aplexer.
     */
    async isAvailable() {
      if (this.available !== null) return this.available;
      let available = false;
      try {
        const res = await this.transport.exec(pathAwareCommand(aplexerProbeCommand()));
        available = res.exitCode === 0 && res.stdout.trim().length > 0;
      } catch {
        available = false;
      }
      this.available = available;
      return available;
    }
    /**
     * Live aplexer sessions as rows in the host's own order, or null when `a`
     * is absent.
     *
     * Null vs [] is the whole contract: null means "no aplexer here, run the
     * tmux path", [] means "aplexer answered and nothing is running". A failed
     * exec on a host that HAS `a` also answers [] — the snapshot is the whole
     * list on such a host, so the tree shows empty for that poll tick and
     * recovers on the next; the legacy tmux path is only for hosts without `a`.
     *
     * [sort] is what the host sorts the list by, and the list's order is the
     * panel's order — the renderer does not re-sort. Hosts whose `a` predates
     * `--sort` get {@link byOldestCreated} instead, which is what such a host
     * showed before the flag existed.
     */
    async listSessions(sort = APLEXER_LIST_SORT) {
      if (!await this.isAvailable()) return null;
      const records = await this.snapshotRecords(sort);
      const rows = records.map(aplexerRecordToSummary);
      if (rows.length > 0) this.onListed?.(rows);
      return rows;
    }
    /**
     * The raw snapshot records, or [] on any failure. Never throws.
     *
     * With [sort], the sorted command is tried first and its DOCUMENT ORDER is
     * kept — that is the feature. When the host cannot do it yet (the flag is
     * refused, remembered for the connection) or the sorted exec dies
     * mid-flight, the unsorted snapshot answers and is sorted client-side, so
     * the order a host without the flag sees is the one it always saw.
     */
    async snapshotRecords(sort) {
      if (sort !== void 0 && this.sortSupported !== false) {
        try {
          const res = await this.transport.exec(pathAwareCommand(aplexerSnapshotCommand(sort)));
          if (res.exitCode === 0) {
            this.sortSupported = true;
            return parseAplexerSnapshot(res.stdout);
          }
          if (isAplexerUnknownFlag(res.stderr)) {
            this.sortSupported = false;
          }
        } catch {
        }
      }
      try {
        const res = await this.transport.exec(pathAwareCommand(aplexerSnapshotCommand()));
        if (res.exitCode !== 0) return [];
        return byOldestCreated(parseAplexerSnapshot(res.stdout));
      } catch {
        return [];
      }
    }
    /** Find one live record by workspace+tag. Null when absent or unknown. */
    async findSession(workspace, tag) {
      const records = await this.snapshotRecords();
      return records.find((r) => r.workspace === workspace && r.tag === tag) ?? null;
    }
    /** All live tags in [workspace] — the client-side free-name walk's input. */
    async liveTags(workspace) {
      if (!await this.isAvailable()) return null;
      const records = await this.snapshotRecords();
      return new Set(records.filter((r) => r.workspace === workspace).map((r) => r.tag));
    }
    /**
     * Start a shell session for [workspace] under [tag].
     *
     * The caller checks liveness first (snapshot); a `liveRefusal` covers the
     * race where the pair went live between that check and this exec. Anything
     * else non-zero is a real failure with the host's own sentence.
     */
    async startSession(opts) {
      let res;
      try {
        res = await this.transport.exec(pathAwareCommand(aplexerStartCommand(opts.workspace, opts.tag)));
      } catch (e) {
        return { ok: false, id: null, tag: null, liveRefusal: false, error: String(e).slice(0, 300) };
      }
      if (res.exitCode === 0) {
        const record = parseSingleAplexerRecord(res.stdout);
        return {
          ok: true,
          id: record?.id ?? null,
          tag: record?.tag ?? opts.tag,
          liveRefusal: false,
          error: null
        };
      }
      if (isAplexerStartRefusal(res.exitCode, res.stderr)) {
        return { ok: false, id: null, tag: null, liveRefusal: true, error: res.stderr.trim() };
      }
      return {
        ok: false,
        id: null,
        tag: null,
        liveRefusal: false,
        error: res.stderr.trim() || res.stdout.trim() || `a start exited ${res.exitCode}`
      };
    }
    /**
     * Kill the session [id]. `notFound` is the ordinary stale-list race, not
     * an error worth alarming over — the caller reports "already gone".
     */
    async killSession(id) {
      let res;
      try {
        res = await this.transport.exec(pathAwareCommand(aplexerKillCommand(id)));
      } catch (e) {
        return { ok: false, notFound: false, error: String(e).slice(0, 300) };
      }
      if (res.exitCode === 0) return { ok: true, notFound: false, error: null };
      if (isAplexerNotFound(res.exitCode, res.stderr)) {
        return { ok: false, notFound: true, error: `"${id}" is not running on this host any more.` };
      }
      return {
        ok: false,
        notFound: false,
        error: res.stderr.trim() || res.stdout.trim() || `a kill exited ${res.exitCode}`
      };
    }
    /** Rename the session [id] to [tag] within its workspace. */
    async renameSession(id, tag) {
      let res;
      try {
        res = await this.transport.exec(pathAwareCommand(aplexerRenameCommand(id, tag)));
      } catch (e) {
        return { ok: false, notFound: false, error: String(e).slice(0, 300) };
      }
      if (res.exitCode === 0) return { ok: true, notFound: false, error: null };
      if (isAplexerNotFound(res.exitCode, res.stderr)) {
        return { ok: false, notFound: true, error: "That session is not running any more." };
      }
      return {
        ok: false,
        notFound: false,
        error: res.stderr.trim() || res.stdout.trim() || `a rename exited ${res.exitCode}`
      };
    }
    /**
     * Every unacknowledged crash/OOM warning on this host, newest first, or []
     * on any failure. Never throws, and [] on a host without `a` — the same
     * total contract as the snapshot, because a warning list the renderer can
     * be denied is a crash it can be denied, and the one thing this endpoint
     * exists to prevent. The availability gate rides the cache the listing
     * warms, so a tmux-only host pays no exec for this per poll tick.
     */
    async listWarnings() {
      if (!await this.isAvailable()) return [];
      try {
        const res = await this.transport.exec(pathAwareCommand(aplexerWarningsCommand()));
        if (res.exitCode !== 0) return [];
        return parseAplexerWarnings(res.stdout);
      } catch {
        return [];
      }
    }
    /**
     * Acknowledge warnings: the whole list when [target] is null, else the one
     * whose session UUID it is. `notFound` is the benign race — the warning
     * was acked from another client between the banner's render and this
     * click — not an error worth alarming over.
     */
    async ackWarnings(target) {
      let res;
      try {
        res = await this.transport.exec(pathAwareCommand(aplexerAckCommand(target)));
      } catch (e) {
        return { ok: false, notFound: false, error: String(e).slice(0, 300) };
      }
      if (res.exitCode === 0) return { ok: true, notFound: false, error: null };
      if (isAplexerAckNotFound(res.exitCode, res.stderr)) {
        return { ok: false, notFound: true, error: null };
      }
      return {
        ok: false,
        notFound: false,
        error: res.stderr.trim() || res.stdout.trim() || `a ack exited ${res.exitCode}`
      };
    }
  };

  // src/agentCommands.ts
  var goalArgument = {
    placeholder: "Goal for this session",
    required: true
  };
  var compactArgument = {
    placeholder: "Optional compaction instructions",
    required: false
  };
  var claudeCode = [
    {
      command: "/clear",
      label: "New / clear conversation",
      description: "Start a fresh conversation (clears current context).",
      destructive: true
    },
    {
      command: "/compact",
      label: "Compact context",
      description: "Summarise the conversation to free up context.",
      argument: compactArgument
    },
    {
      command: "/goal",
      label: "Goal",
      description: "Set a persistent objective for the session.",
      argument: goalArgument
    },
    {
      command: "/rewind",
      label: "Rewind",
      description: "Roll back to an earlier point in the conversation.",
      destructive: true
    },
    // Long tail (searchable).
    { command: "/resume", label: "Resume", description: "Resume a previous conversation." },
    { command: "/context", label: "Context", description: "Show the current context usage." },
    { command: "/model", label: "Model", description: "Switch the active model." },
    { command: "/cost", label: "Cost", description: "Show token cost for the session." },
    { command: "/review", label: "Review", description: "Request a code review." },
    { command: "/init", label: "Init", description: "Initialise project memory (CLAUDE.md)." }
  ];
  var codex = [
    {
      command: "/new",
      label: "New conversation",
      description: "Start a fresh conversation in this CLI session.",
      destructive: true
    },
    {
      command: "/compact",
      label: "Compact context",
      description: "Summarise the conversation to free up context.",
      argument: compactArgument
    },
    {
      command: "/goal",
      label: "Goal",
      description: "Set a persistent objective for the session.",
      argument: goalArgument
    },
    { command: "/diff", label: "Diff", description: "Show the working-tree diff." },
    // Long tail (searchable).
    {
      command: "/clear",
      label: "Clear",
      description: "Clear the terminal and start a fresh chat.",
      destructive: true
    },
    { command: "/resume", label: "Resume", description: "Resume a previous conversation." },
    { command: "/review", label: "Review", description: "Request a code review." },
    { command: "/status", label: "Status", description: "Show the current session status." },
    { command: "/model", label: "Model", description: "Switch the active model." },
    { command: "/init", label: "Init", description: "Initialise project memory." }
  ];
  var openCode = [
    {
      command: "/new",
      label: "New / clear conversation",
      description: "Start a fresh conversation (clears current context).",
      destructive: true
    },
    {
      command: "/compact",
      label: "Compact context",
      description: "Summarise the conversation to free up context.",
      argument: compactArgument
    },
    { command: "/sessions", label: "Sessions", description: "Browse and resume previous sessions." },
    { command: "/undo", label: "Undo", description: "Undo the last change.", destructive: true },
    // Long tail (searchable).
    { command: "/redo", label: "Redo", description: "Redo the last undone change." },
    { command: "/share", label: "Share", description: "Create a shareable link for the session." },
    { command: "/export", label: "Export", description: "Export the conversation." },
    { command: "/models", label: "Models", description: "Switch the active model." },
    { command: "/init", label: "Init", description: "Initialise project memory." }
  ];
  var grokBuild = [
    {
      command: "/new",
      label: "New conversation",
      description: "Start a fresh conversation in this CLI session.",
      destructive: true
    },
    {
      command: "/compact",
      label: "Compact context",
      description: "Summarise the conversation to free up context.",
      argument: compactArgument
    },
    { command: "/context", label: "Context", description: "Show the current context usage." },
    { command: "/export", label: "Export", description: "Export the current session." },
    // Long tail (searchable).
    {
      command: "/clear",
      label: "Clear",
      description: "Clear the conversation history.",
      destructive: true
    },
    { command: "/models", label: "Models", description: "Switch the active model." },
    { command: "/usage", label: "Usage", description: "Show token usage for the session." },
    { command: "/mcp", label: "MCP servers", description: "Manage connected MCP servers." },
    { command: "/init", label: "Init", description: "Initialise project memory." },
    { command: "/help", label: "Help", description: "List the CLI's own commands." }
  ];
  function commandsFor(agent) {
    switch (agent) {
      case "claude":
        return claudeCode;
      case "codex":
        return codex;
      case "opencode":
        return openCode;
      case "grok":
        return grokBuild;
      default:
        return [];
    }
  }
  function filterCommands(agent, query) {
    const all = commandsFor(agent);
    const needle = query.trim().toLowerCase();
    if (needle === "") return all;
    return all.filter(
      (c) => c.command.toLowerCase().includes(needle) || c.label.toLowerCase().includes(needle) || c.description.toLowerCase().includes(needle)
    );
  }
  function filteredCommands(agent, query) {
    if (agent === null) return [];
    return filterCommands(agent, query);
  }
  function insertionTextFor(command) {
    return command.argument ? command.command + " " : command.command;
  }

  // src/agentLaunch.ts
  var LAUNCHABLE_KINDS = ["claude", "codex", "opencode", "grok"];
  var HELPER_BASELINE_KINDS = ["claude", "codex", "opencode"];
  var HELPER_VERSION_WITHOUT_GROK = "0.4.44";
  var KIND_LABELS = {
    claude: "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
    grok: "Grok"
  };
  function isLaunchableKind(kind) {
    return kind !== null && LAUNCHABLE_KINDS.includes(kind);
  }
  function kindNeedsNewerHelper(kind) {
    return !HELPER_BASELINE_KINDS.includes(kind);
  }
  function supportsSkipPermissions(kind) {
    return kind !== "opencode" && kind !== "grok";
  }
  function supportsProfiles(kind) {
    return kind !== "opencode" && kind !== "grok";
  }
  function kindUnavailableReason(kind, support) {
    const label = KIND_LABELS[kind];
    const listed = Array.isArray(support.subcommands) ? support.subcommands : null;
    if (listed !== null) {
      if (listed.includes(kind)) return null;
      const has = support.helperVersion?.trim();
      const running = has ? ` This host runs ${has}.` : "";
      if (kindNeedsNewerHelper(kind)) {
        return `This host\u2019s pocketshell helper is too old to start ${label} \u2014 its \`pocketshell agent\` has no \`${kind}\` subcommand. ${label} needs a helper newer than ${HELPER_VERSION_WITHOUT_GROK}.${running}`;
      }
      return `This host\u2019s \`pocketshell agent\` does not list a \`${kind}\` subcommand, so ${label} cannot be started here.${running}`;
    }
    if (!kindNeedsNewerHelper(kind)) return null;
    if (support.probing) {
      return `Checking whether this host\u2019s pocketshell can start ${label}\u2026`;
    }
    return `Could not ask this host which agents its pocketshell can start, and ${label} needs a helper newer than ${HELPER_VERSION_WITHOUT_GROK} \u2014 so it is not offered here. Pick another agent, or reconnect and try again.`;
  }
  function parseProfileRows(rows) {
    const out = [];
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const r = row;
      const name = typeof r["name"] === "string" ? r["name"].trim() : "";
      const engine = typeof r["engine"] === "string" ? r["engine"].trim() : "";
      if (name === "" || engine === "") continue;
      const rawDir = r["config_dir"];
      out.push({
        name,
        engine,
        configDir: typeof rawDir === "string" && rawDir.trim() !== "" ? rawDir.trim() : null,
        default: r["default"] === true
      });
    }
    return out;
  }
  function profilesFor(kind, profiles) {
    if (!supportsProfiles(kind)) return [];
    return profiles.filter((p) => p.engine === kind);
  }
  function profileFlagName(picked, available) {
    if (!picked) return null;
    const match = available.find((p) => p.name === picked);
    if (!match || match.default) return null;
    return match.name;
  }
  function buildLaunchCommand(choice) {
    const parts = ["pocketshell", "agent", choice.kind, "--dir", shellQuoteRemotePath(choice.dir)];
    if (supportsSkipPermissions(choice.kind) && !choice.skipPermissions) {
      parts.push("--no-skip-permissions");
    }
    const profile = choice.profile?.trim();
    if (supportsProfiles(choice.kind) && profile) {
      parts.push("--profile", shellQuote(profile));
    }
    return parts.join(" ");
  }
  function launchBlocker(choice, support) {
    if (!choice.kind || !isLaunchableKind(choice.kind)) {
      return "Pick an agent to launch.";
    }
    if (support) {
      const unavailable = kindUnavailableReason(choice.kind, support);
      if (unavailable) return unavailable;
    }
    if (!choice.dir || choice.dir.trim() === "") {
      return "This folder has no known directory on the host, so an agent cannot be launched in it.";
    }
    return null;
  }

  // src/composerSend.ts
  var BP_START = "\x1B[200~";
  var BP_END = "\x1B[201~";
  var SUBMIT_KEY = "\r";
  var composerTiming = {
    submitDelayMs: 250,
    sendTimeoutMs: 12e3
  };
  function needsBracketedPaste(payload) {
    return payload.includes("\n") || payload.includes("\r");
  }
  function frameForPaste(payload) {
    return needsBracketedPaste(payload) ? BP_START + payload + BP_END : payload;
  }
  var PASTE_GAP_MS = 120;
  var defaultSleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
  async function deliverPayload(payload, opts) {
    const delay = opts.submitDelayMs ?? composerTiming.submitDelayMs;
    const sleep = opts.sleep ?? defaultSleep;
    const parts = needsBracketedPaste(payload) ? [BP_START, payload, BP_END] : [payload];
    for (const [i, part] of parts.entries()) {
      if (!await opts.write(part)) return false;
      if (i < parts.length - 1 && PASTE_GAP_MS > 0) await sleep(PASTE_GAP_MS);
    }
    if (delay > 0) await sleep(delay);
    return opts.write(SUBMIT_KEY);
  }
  function composerAgentKind(kind) {
    switch (kind) {
      case "claude":
      case "codex":
      case "opencode":
      case "grok":
        return kind;
      default:
        return null;
    }
  }
  function sendRoute(input) {
    if (input.withEnter && input.liveAgent === "codex") return "agent-payload";
    if (input.liveAgent !== null) return "raw";
    if (input.presumedAgent !== null) return "agent-payload";
    return "raw";
  }
  async function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== void 0) clearTimeout(timer);
    }
  }
  return __toCommonJS(index_exports);
})();
