const productPrefixes = [
  'AGENT_',
  'ANTHROPIC_',
  'DEEPSEEK_',
  'GEMINI_',
  'GOOGLE_',
  'MIMI_',
  'NANO_',
  'OPENAI_',
];

const productVariables = new Set([
  'CONTEXT_WINDOW',
  'DOTENV_CONFIG_PATH',
  'HISTORY_LIMIT',
  'MAX_TURNS',
  'MODEL_PROVIDER',
  'OUTPUT_LEVEL',
  'OUTPUT_TOKEN_RESERVE',
  'TEAM_MAX_CONCURRENCY',
  'TRUST_WORKSPACE_MCP',
]);

for (const name of Object.keys(process.env)) {
  if (
    productPrefixes.some((prefix) => name.startsWith(prefix))
    || productVariables.has(name)
    || /(?:_API_KEY|_CREDENTIAL|_PASSWORD|_SECRET|_TOKEN)$/.test(name)
  ) {
    delete process.env[name];
  }
}
