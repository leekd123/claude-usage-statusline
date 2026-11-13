export type Tokens = number

declare module 'claude-code' {
  interface PluginState {
    'usage-statusline': { tokens: Tokens }
  }
}
