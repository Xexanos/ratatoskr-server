export class ConfigError extends Error {
  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}
