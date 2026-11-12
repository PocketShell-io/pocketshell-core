import { describe, expect, it } from 'vitest';
import {
  agentKindFromEngine,
  aplexerRecordToSummary,
  byOldestCreated,
  parseAplexerEngineIds,
  parseAplexerSnapshot,
} from '../src/aplexerParsers';

const LIVE_ROW = {
  id: '11111111-1111-1111-1111-111111111111',
  workspace: '/home/alexey/git/pocketshell-web',
  tag: 'main',
  engine: 'codex',
  cwd: '/home/alexey/git/pocketshell-web',
  phase: 'running',
  worker_alive: true,
  created_at_ms: 1_000_000,
  last_activity_ms: 2_000_000,
};

describe('parseAplexerSnapshot', () => {
  it('parses the live rows in document order', () => {
    const rows = parseAplexerSnapshot(JSON.stringify([LIVE_ROW, { ...LIVE_ROW, id: '2', tag: 'ssh-broke' }]));
    expect(rows.map((r) => r.tag)).toEqual(['main', 'ssh-broke']);
  });

  it('drops dead workers and unenriched terminal phases — liveness is the pair, never the phase alone', () => {
    const dead = { ...LIVE_ROW, worker_alive: false };
    // No worker_alive field at all plus a terminal phase: an old host — a
    // session that will never attach again. (`worker_alive: undefined`
    // serialises out of JSON.stringify, which is the point.)
    const gone = { ...LIVE_ROW, phase: 'exited', worker_alive: undefined };
    const failed = { ...LIVE_ROW, phase: 'failed', worker_alive: undefined };
    // The host explicitly says alive: the row stays even on a terminal
    // phase — contradictory host data is the host's to prune, not ours to
    // hide. Same rule the desktop's parser pins.
    const exitedLive = { ...LIVE_ROW, phase: 'exited' };
    const rows = parseAplexerSnapshot(JSON.stringify([dead, gone, failed, exitedLive]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phase).toBe('exited');
  });

  it('drops corrupt rows individually, not the batch', () => {
    const rows = parseAplexerSnapshot(
      JSON.stringify([{ nope: true }, LIVE_ROW, 'a string', { id: '', workspace: 'w', tag: 't' }]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(LIVE_ROW.id);
  });

  it('answers [] for unparseable or non-array bodies', () => {
    expect(parseAplexerSnapshot('command not found')).toEqual([]);
    expect(parseAplexerSnapshot('{"not":"an array"}')).toEqual([]);
    expect(parseAplexerSnapshot('')).toEqual([]);
  });

  it('defaults missing optional fields', () => {
    const rows = parseAplexerSnapshot(
      JSON.stringify([{ id: 'x', workspace: '/w', tag: 't', phase: 'running', created_at_ms: 5 }]),
    );
    expect(rows[0]).toMatchObject({ engine: '', created_at_ms: 5 });
    expect('cwd' in rows[0]!).toBe(false);
    expect('last_activity_ms' in rows[0]!).toBe(false);
    // Old host: no derived `agent` field, and the row stays a valid record.
    expect('agent' in rows[0]!).toBe(false);
  });

  it('keeps the live agent: string, null, and absent are three different rows', () => {
    const rows = parseAplexerSnapshot(
      JSON.stringify([
        { ...LIVE_ROW, tag: 'live', agent: 'codex' },
        { ...LIVE_ROW, tag: 'quiet', agent: null },
        LIVE_ROW,
      ]),
    );
    expect(rows.map((r) => r.agent)).toEqual(['codex', null, undefined]);
  });
});

describe('byOldestCreated', () => {
  it('sorts oldest first, stable within a tick', () => {
    const a = { ...LIVE_ROW, id: 'a', created_at_ms: 300 };
    const b = { ...LIVE_ROW, id: 'b', created_at_ms: 100 };
    const c = { ...LIVE_ROW, id: 'c', created_at_ms: 200 };
    expect(byOldestCreated([a, b, c]).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('agentKindFromEngine', () => {
  it('maps the known engines and refuses the rest', () => {
    expect(agentKindFromEngine('claude')).toBe('claude');
    expect(agentKindFromEngine('CODEX')).toBe('codex');
    expect(agentKindFromEngine(' opencode ')).toBe('opencode');
    expect(agentKindFromEngine('grok')).toBe('grok');
    expect(agentKindFromEngine('shell')).toBe('shell');
    expect(agentKindFromEngine('mystery')).toBeNull();
    expect(agentKindFromEngine('')).toBeNull();
  });
});

describe('aplexerRecordToSummary', () => {
  it('carries the tag as the name and the workspace as the path', () => {
    const summary = aplexerRecordToSummary(LIVE_ROW);
    expect(summary).toMatchObject({
      name: 'main',
      tag: 'main',
      workspace: LIVE_ROW.workspace,
      path: LIVE_ROW.workspace,
      aplexerId: LIVE_ROW.id,
      agentKind: 'codex',
      backend: 'aplexer',
      attached: false,
      created: 1000,
      activity: 2000,
      aplexerPhase: 'running',
    });
  });

  it('falls back to cwd when the workspace is unusable, and activity to created', () => {
    const summary = aplexerRecordToSummary({
      ...LIVE_ROW,
      workspace: '',
      cwd: '/tmp/fallback',
      last_activity_ms: undefined,
    });
    expect(summary.path).toBe('/tmp/fallback');
    expect(summary.activity).toBe(1000);
  });

  it('badges the LIVE agent over the declared engine — the PocketShell session is engine shell, agent codex', () => {
    const summary = aplexerRecordToSummary({ ...LIVE_ROW, engine: 'shell', agent: 'codex' });
    expect(summary.agentKind).toBe('codex');
  });

  it('falls back to the declared engine when no agent is live or the field predates the host', () => {
    expect(aplexerRecordToSummary({ ...LIVE_ROW, engine: 'claude', agent: null }).agentKind).toBe(
      'claude',
    );
    const { agent: _agent, ...oldHost } = { ...LIVE_ROW, engine: 'grok' };
    expect(aplexerRecordToSummary(oldHost).agentKind).toBe('grok');
  });
});

describe('aplexerRecordToSummary on a Windows host', () => {
  it('folds the host backslash workspace to the forward-drive form the app speaks', () => {
    const summary = aplexerRecordToSummary({
      ...LIVE_ROW,
      workspace: 'C:\\Users\\User\\git\\aplexer',
      cwd: 'C:\\Users\\User\\git\\aplexer',
    });
    expect(summary.workspace).toBe('C:/Users/User/git/aplexer');
    expect(summary.path).toBe('C:/Users/User/git/aplexer');
  });

  it('leaves POSIX workspaces untouched', () => {
    const summary = aplexerRecordToSummary({
      ...LIVE_ROW,
      workspace: '/home/u/git/aplexer',
      cwd: '/home/u/git/aplexer',
    });
    expect(summary.workspace).toBe('/home/u/git/aplexer');
    expect(summary.path).toBe('/home/u/git/aplexer');
  });
});

describe('parseAplexerEngineIds', () => {
  /** The real [
  {
    "available": true,
    "command": [
      "agy"
    ],
    "env_unset": [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "AWS_REGION",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_ROLE_ARN",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_ORG_ID",
      "OPENAI_PROJECT_ID",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "GROQ_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_API_KEY",
      "VERTEX_LOCATION",
      "VERTEX_AI_PROJECT",
      "DEEPSEEK_API_KEY",
      "XAI_API_KEY",
      "FIREWORKS_API_KEY",
      "CEREBRAS_API_KEY",
      "OPENROUTER_API_KEY",
      "TOGETHER_API_KEY",
      "TOGETHER_AI_API_KEY",
      "AZURE_API_KEY",
      "AZURE_RESOURCE_NAME",
      "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME",
      "AZURE_OPENAI_API_KEY",
      "AZURE_OPENAI_ENDPOINT",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_GATEWAY_ID",
      "CLOUDFLARE_API_KEY",
      "HUGGING_FACE_API_KEY",
      "HF_TOKEN",
      "HF_API_TOKEN",
      "MOONSHOT_API_KEY",
      "MOONSHOTAI_API_KEY",
      "MINIMAX_API_KEY",
      "NEBIUS_API_KEY",
      "DEEPINFRA_API_KEY",
      "BASETEN_API_KEY",
      "VENICE_API_KEY",
      "SCALEWAY_API_KEY",
      "OVH_API_KEY",
      "CORTECS_API_KEY",
      "IONET_API_KEY",
      "VERCEL_API_KEY",
      "ZENMUX_API_KEY",
      "ZAI_API_KEY",
      "HELICONE_API_KEY",
      "OPENCODE_API_KEY",
      "OPENCODE_ZEN_API_KEY",
      "GITLAB_TOKEN",
      "GITLAB_INSTANCE_URL",
      "GITLAB_AI_GATEWAY_URL",
      "GITLAB_OAUTH_CLIENT_ID",
      "AICORE_SERVICE_KEY",
      "AICORE_DEPLOYMENT_ID",
      "AICORE_RESOURCE_GROUP",
      "OPENAI_COMPATIBLE_API_KEY",
      "LMSTUDIO_API_KEY",
      "OLLAMA_API_KEY",
      "302AI_API_KEY",
      "FIRMWARE_API_KEY",
      "2AI_API_KEY",
      "GEMINI_API_KEY"
    ],
    "env_unset_count": 71,
    "name": "antigravity"
  },
  {
    "available": true,
    "command": [
      "claude"
    ],
    "env_unset": [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "AWS_REGION",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_ROLE_ARN",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_ORG_ID",
      "OPENAI_PROJECT_ID",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "GROQ_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_API_KEY",
      "VERTEX_LOCATION",
      "VERTEX_AI_PROJECT",
      "DEEPSEEK_API_KEY",
      "XAI_API_KEY",
      "FIREWORKS_API_KEY",
      "CEREBRAS_API_KEY",
      "OPENROUTER_API_KEY",
      "TOGETHER_API_KEY",
      "TOGETHER_AI_API_KEY",
      "AZURE_API_KEY",
      "AZURE_RESOURCE_NAME",
      "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME",
      "AZURE_OPENAI_API_KEY",
      "AZURE_OPENAI_ENDPOINT",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_GATEWAY_ID",
      "CLOUDFLARE_API_KEY",
      "HUGGING_FACE_API_KEY",
      "HF_TOKEN",
      "HF_API_TOKEN",
      "MOONSHOT_API_KEY",
      "MOONSHOTAI_API_KEY",
      "MINIMAX_API_KEY",
      "NEBIUS_API_KEY",
      "DEEPINFRA_API_KEY",
      "BASETEN_API_KEY",
      "VENICE_API_KEY",
      "SCALEWAY_API_KEY",
      "OVH_API_KEY",
      "CORTECS_API_KEY",
      "IONET_API_KEY",
      "VERCEL_API_KEY",
      "ZENMUX_API_KEY",
      "ZAI_API_KEY",
      "HELICONE_API_KEY",
      "OPENCODE_API_KEY",
      "OPENCODE_ZEN_API_KEY",
      "GITLAB_TOKEN",
      "GITLAB_INSTANCE_URL",
      "GITLAB_AI_GATEWAY_URL",
      "GITLAB_OAUTH_CLIENT_ID",
      "AICORE_SERVICE_KEY",
      "AICORE_DEPLOYMENT_ID",
      "AICORE_RESOURCE_GROUP",
      "OPENAI_COMPATIBLE_API_KEY",
      "LMSTUDIO_API_KEY",
      "OLLAMA_API_KEY",
      "302AI_API_KEY",
      "FIRMWARE_API_KEY",
      "2AI_API_KEY",
      "GEMINI_API_KEY"
    ],
    "env_unset_count": 71,
    "name": "claude"
  },
  {
    "available": true,
    "command": [
      "codex",
      "-c",
      "check_for_update_on_startup=false"
    ],
    "env_unset": [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "AWS_REGION",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_ROLE_ARN",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_ORG_ID",
      "OPENAI_PROJECT_ID",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "GROQ_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_API_KEY",
      "VERTEX_LOCATION",
      "VERTEX_AI_PROJECT",
      "DEEPSEEK_API_KEY",
      "XAI_API_KEY",
      "FIREWORKS_API_KEY",
      "CEREBRAS_API_KEY",
      "OPENROUTER_API_KEY",
      "TOGETHER_API_KEY",
      "TOGETHER_AI_API_KEY",
      "AZURE_API_KEY",
      "AZURE_RESOURCE_NAME",
      "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME",
      "AZURE_OPENAI_API_KEY",
      "AZURE_OPENAI_ENDPOINT",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_GATEWAY_ID",
      "CLOUDFLARE_API_KEY",
      "HUGGING_FACE_API_KEY",
      "HF_TOKEN",
      "HF_API_TOKEN",
      "MOONSHOT_API_KEY",
      "MOONSHOTAI_API_KEY",
      "MINIMAX_API_KEY",
      "NEBIUS_API_KEY",
      "DEEPINFRA_API_KEY",
      "BASETEN_API_KEY",
      "VENICE_API_KEY",
      "SCALEWAY_API_KEY",
      "OVH_API_KEY",
      "CORTECS_API_KEY",
      "IONET_API_KEY",
      "VERCEL_API_KEY",
      "ZENMUX_API_KEY",
      "ZAI_API_KEY",
      "HELICONE_API_KEY",
      "OPENCODE_API_KEY",
      "OPENCODE_ZEN_API_KEY",
      "GITLAB_TOKEN",
      "GITLAB_INSTANCE_URL",
      "GITLAB_AI_GATEWAY_URL",
      "GITLAB_OAUTH_CLIENT_ID",
      "AICORE_SERVICE_KEY",
      "AICORE_DEPLOYMENT_ID",
      "AICORE_RESOURCE_GROUP",
      "OPENAI_COMPATIBLE_API_KEY",
      "LMSTUDIO_API_KEY",
      "OLLAMA_API_KEY",
      "302AI_API_KEY",
      "FIRMWARE_API_KEY",
      "2AI_API_KEY",
      "GEMINI_API_KEY"
    ],
    "env_unset_count": 71,
    "name": "codex"
  },
  {
    "available": true,
    "command": [
      "gemini"
    ],
    "env_unset": [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "AWS_REGION",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_ROLE_ARN",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_ORG_ID",
      "OPENAI_PROJECT_ID",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "GROQ_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_API_KEY",
      "VERTEX_LOCATION",
      "VERTEX_AI_PROJECT",
      "DEEPSEEK_API_KEY",
      "XAI_API_KEY",
      "FIREWORKS_API_KEY",
      "CEREBRAS_API_KEY",
      "OPENROUTER_API_KEY",
      "TOGETHER_API_KEY",
      "TOGETHER_AI_API_KEY",
      "AZURE_API_KEY",
      "AZURE_RESOURCE_NAME",
      "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME",
      "AZURE_OPENAI_API_KEY",
      "AZURE_OPENAI_ENDPOINT",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_GATEWAY_ID",
      "CLOUDFLARE_API_KEY",
      "HUGGING_FACE_API_KEY",
      "HF_TOKEN",
      "HF_API_TOKEN",
      "MOONSHOT_API_KEY",
      "MOONSHOTAI_API_KEY",
      "MINIMAX_API_KEY",
      "NEBIUS_API_KEY",
      "DEEPINFRA_API_KEY",
      "BASETEN_API_KEY",
      "VENICE_API_KEY",
      "SCALEWAY_API_KEY",
      "OVH_API_KEY",
      "CORTECS_API_KEY",
      "IONET_API_KEY",
      "VERCEL_API_KEY",
      "ZENMUX_API_KEY",
      "ZAI_API_KEY",
      "HELICONE_API_KEY",
      "OPENCODE_API_KEY",
      "OPENCODE_ZEN_API_KEY",
      "GITLAB_TOKEN",
      "GITLAB_INSTANCE_URL",
      "GITLAB_AI_GATEWAY_URL",
      "GITLAB_OAUTH_CLIENT_ID",
      "AICORE_SERVICE_KEY",
      "AICORE_DEPLOYMENT_ID",
      "AICORE_RESOURCE_GROUP",
      "OPENAI_COMPATIBLE_API_KEY",
      "LMSTUDIO_API_KEY",
      "OLLAMA_API_KEY",
      "302AI_API_KEY",
      "FIRMWARE_API_KEY",
      "2AI_API_KEY",
      "GEMINI_API_KEY"
    ],
    "env_unset_count": 71,
    "name": "gemini"
  },
  {
    "available": true,
    "command": [
      "grok"
    ],
    "env_unset": [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "AWS_REGION",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_ROLE_ARN",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_ORG_ID",
      "OPENAI_PROJECT_ID",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "GROQ_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_API_KEY",
      "VERTEX_LOCATION",
      "VERTEX_AI_PROJECT",
      "DEEPSEEK_API_KEY",
      "XAI_API_KEY",
      "FIREWORKS_API_KEY",
      "CEREBRAS_API_KEY",
      "OPENROUTER_API_KEY",
      "TOGETHER_API_KEY",
      "TOGETHER_AI_API_KEY",
      "AZURE_API_KEY",
      "AZURE_RESOURCE_NAME",
      "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME",
      "AZURE_OPENAI_API_KEY",
      "AZURE_OPENAI_ENDPOINT",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_GATEWAY_ID",
      "CLOUDFLARE_API_KEY",
      "HUGGING_FACE_API_KEY",
      "HF_TOKEN",
      "HF_API_TOKEN",
      "MOONSHOT_API_KEY",
      "MOONSHOTAI_API_KEY",
      "MINIMAX_API_KEY",
      "NEBIUS_API_KEY",
      "DEEPINFRA_API_KEY",
      "BASETEN_API_KEY",
      "VENICE_API_KEY",
      "SCALEWAY_API_KEY",
      "OVH_API_KEY",
      "CORTECS_API_KEY",
      "IONET_API_KEY",
      "VERCEL_API_KEY",
      "ZENMUX_API_KEY",
      "ZAI_API_KEY",
      "HELICONE_API_KEY",
      "OPENCODE_API_KEY",
      "OPENCODE_ZEN_API_KEY",
      "GITLAB_TOKEN",
      "GITLAB_INSTANCE_URL",
      "GITLAB_AI_GATEWAY_URL",
      "GITLAB_OAUTH_CLIENT_ID",
      "AICORE_SERVICE_KEY",
      "AICORE_DEPLOYMENT_ID",
      "AICORE_RESOURCE_GROUP",
      "OPENAI_COMPATIBLE_API_KEY",
      "LMSTUDIO_API_KEY",
      "OLLAMA_API_KEY",
      "302AI_API_KEY",
      "FIRMWARE_API_KEY",
      "2AI_API_KEY",
      "GEMINI_API_KEY"
    ],
    "env_unset_count": 71,
    "name": "grok"
  },
  {
    "available": true,
    "command": [
      "C:\Users\alexey\AppData\Roaming\agent-hub\managed-engines\shared-go-bebd83e0-8e3f-4114-b8b0-cc2d40291650\engine\node_modules\@opencode\cli-windows-x64-baseline\bin\opencode.exe"
    ],
    "env_unset": [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "AWS_REGION",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_ROLE_ARN",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_ORG_ID",
      "OPENAI_PROJECT_ID",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "GROQ_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_API_KEY",
      "VERTEX_LOCATION",
      "VERTEX_AI_PROJECT",
      "DEEPSEEK_API_KEY",
      "XAI_API_KEY",
      "FIREWORKS_API_KEY",
      "CEREBRAS_API_KEY",
      "OPENROUTER_API_KEY",
      "TOGETHER_API_KEY",
      "TOGETHER_AI_API_KEY",
      "AZURE_API_KEY",
      "AZURE_RESOURCE_NAME",
      "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME",
      "AZURE_OPENAI_API_KEY",
      "AZURE_OPENAI_ENDPOINT",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_GATEWAY_ID",
      "CLOUDFLARE_API_KEY",
      "HUGGING_FACE_API_KEY",
      "HF_TOKEN",
      "HF_API_TOKEN",
      "MOONSHOT_API_KEY",
      "MOONSHOTAI_API_KEY",
      "MINIMAX_API_KEY",
      "NEBIUS_API_KEY",
      "DEEPINFRA_API_KEY",
      "BASETEN_API_KEY",
      "VENICE_API_KEY",
      "SCALEWAY_API_KEY",
      "OVH_API_KEY",
      "CORTECS_API_KEY",
      "IONET_API_KEY",
      "VERCEL_API_KEY",
      "ZENMUX_API_KEY",
      "ZAI_API_KEY",
      "HELICONE_API_KEY",
      "OPENCODE_API_KEY",
      "OPENCODE_ZEN_API_KEY",
      "GITLAB_TOKEN",
      "GITLAB_INSTANCE_URL",
      "GITLAB_AI_GATEWAY_URL",
      "GITLAB_OAUTH_CLIENT_ID",
      "AICORE_SERVICE_KEY",
      "AICORE_DEPLOYMENT_ID",
      "AICORE_RESOURCE_GROUP",
      "OPENAI_COMPATIBLE_API_KEY",
      "LMSTUDIO_API_KEY",
      "OLLAMA_API_KEY",
      "302AI_API_KEY",
      "FIRMWARE_API_KEY",
      "2AI_API_KEY",
      "GEMINI_API_KEY"
    ],
    "env_unset_count": 71,
    "name": "opencode"
  },
  {
    "available": true,
    "command": [
      "C:\Program Files\Git\bin\bash.exe",
      "--login",
      "-i"
    ],
    "env_unset": [],
    "env_unset_count": 0,
    "name": "shell"
  }
] row shape (python/tests/test_client.py). */
  const ENGINES = JSON.stringify([
    { name: 'codex', command: ['codex'], available: true, env_unset: [] },
    { name: 'claude', command: ['claude'], available: true, env_unset: [] },
    { name: 'grok', command: ['grok'], available: false, env_unset: [] },
    { name: 'shell', command: ['bash'], available: true, env_unset: [] },
  ]);

  it('answers the available engine names, unavailable rows dropped', () => {
    expect(parseAplexerEngineIds(ENGINES)).toEqual(['codex', 'claude', 'shell']);
  });

  it('answers [] for a successful query with nothing available', () => {
    expect(parseAplexerEngineIds('[{"name":"grok","command":["grok"],"available":false}]')).toEqual([]);
    expect(parseAplexerEngineIds('[]')).toEqual([]);
  });

  it.each([
    ['not json', 'command not found: a'],
    ['not an array', '{"engines":[]}'],
    ['rows without names', '[{"available":true}]'],
    ['rows without the boolean', '[{"name":"codex"}]'],
    ['non-object rows', '["codex", 3, null]'],
  ])('answers null for unusable output (%s)', (_label, stdout) => {
    expect(parseAplexerEngineIds(stdout)).toBeNull();
  });

  it('drops a corrupt row instead of refusing the batch', () => {
    const rows = JSON.parse(ENGINES) as unknown[];
    expect(parseAplexerEngineIds(JSON.stringify([...rows, { nope: true }]))).toEqual(['codex', 'claude', 'shell']);
  });
});
