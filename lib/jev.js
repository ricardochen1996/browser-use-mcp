/**
 * Jev: the policy behind `browser_goal` and `browser_act`'s intent, and where its endpoints come from.
 *
 * In `dsh-browser-use` these values are resolved from the harness configuration and inherited from
 * the conversation's model route. An MCP server has no conversation to inherit from, so the values
 * come from the server's own configuration (flags and environment), and are handed to the sidecar
 * with each call that spends model quota — never left in the server's environment, where a goal run
 * could read a stale key.
 *
 * @module browser-use-mcp/jev
 */

/** Variables the engine reads for one model-calling request; nothing else may leak into a sidecar. */
export const ENGINE_VARIABLES = [
  'JEV_DECIDER',
  'TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'TYPESAFE_MODEL', 'TYPESAFE_FALLBACK_URL',
  'TEXT_MODEL_API_KEY', 'TEXT_MODEL_BASE_URL', 'TEXT_MODEL', 'TEXT_MODEL_REASONING', 'TEXT_MODEL_HEADERS',
]

/**
 * The engine environment for the next model-spending request, or `{}` when none is configured.
 *
 * With `jev-decider chat` the sidecar serves the engine's chat-model endpoint on loopback and points
 * the engine's TypeSafe variables at it, so the TypeSafe values are deliberately not sent: the text
 * model is the only model that run resolves.
 * @param {object} config - the resolved configuration.
 */
export function jevEnvironment(config) {
  if (!config.jev.enabled) return {}
  const env = {}
  const set = (name, value) => {
    if (value !== undefined && value !== null && String(value) !== '') env[name] = String(value)
  }
  if (config.jev.decider === 'chat') {
    env.JEV_DECIDER = 'chat'
  } else {
    set('TYPESAFE_BASE_URL', config.jev.typesafe.baseURL)
    set('TYPESAFE_MODEL', config.jev.typesafe.model)
    set('TYPESAFE_FALLBACK_URL', config.jev.typesafe.fallbackURL)
    set('TYPESAFE_API_KEY', config.jev.typesafe.apiKey)
  }
  set('TEXT_MODEL_API_KEY', config.jev.textModel.apiKey)
  set('TEXT_MODEL_BASE_URL', config.jev.textModel.baseURL)
  set('TEXT_MODEL', config.jev.textModel.model)
  set('TEXT_MODEL_REASONING', config.jev.textModel.reasoning)
  if (Object.keys(config.jev.textModel.headers).length > 0) {
    set('TEXT_MODEL_HEADERS', JSON.stringify(config.jev.textModel.headers))
  }
  return env
}

/**
 * Whether a policy call can run at all with this configuration, and what is missing if not.
 *
 * This is the question the tool asks *before* it reaches the engine, so a misconfigured server gets
 * one sentence naming the variable to set instead of an engine stack trace. It is not a promise that
 * a configured endpoint answers: only a real call can know that.
 * @param {object} config - the resolved configuration.
 * @returns {{ready: boolean, missing: string[], description: string}}
 */
export function jevReadiness(config) {
  if (!config.jev.enabled) {
    return { ready: false, missing: [], description: 'Jev is off (--no-jev): browser_goal and browser_act intents are not offered.' }
  }
  if (config.jev.decider === 'chat') {
    const missing = []
    if (config.jev.textModel.baseURL === '') missing.push('TEXT_MODEL_BASE_URL')
    if (config.jev.textModel.model === '') missing.push('TEXT_MODEL')
    return {
      ready: missing.length === 0,
      missing,
      description: missing.length === 0
        ? `the text model ${config.jev.textModel.model} at ${config.jev.textModel.baseURL} decides (--jev-decider chat)`
        : `--jev-decider chat needs ${missing.join(' and ')} so the text model can decide`,
    }
  }
  const missing = []
  if (config.jev.typesafe.apiKey === '') missing.push('TYPESAFE_API_KEY')
  // The text helper writes a TYPE_TEXT value; a goal with only clicks needs no text model, so this
  // is reported but does not make the policy unusable.
  const textNote = config.jev.textModel.apiKey === '' && config.jev.textModel.baseURL === ''
    ? '; TYPE_TEXT values need TEXT_MODEL_API_KEY/TEXT_MODEL_BASE_URL/TEXT_MODEL, or write them yourself with browser_act'
    : ''
  return {
    ready: missing.length === 0,
    missing,
    description: missing.length === 0
      ? `Jev at ${config.jev.typesafe.baseURL || 'the default TypeSafe endpoint'} (model ${config.jev.typesafe.model || 'default'}) decides${textNote}`
      : `${missing.join(' and ')} is required for browser_goal and browser_act intents, or pass --jev-decider chat with TEXT_MODEL_*`,
  }
}

/**
 * Where the Jev credentials come from, in one line the doctor can print — never a key itself.
 * @param {object} config - the resolved configuration.
 * @returns {string}
 */
export function jevDescribe(config) {
  if (!config.jev.enabled) return 'off (--no-jev)'
  const key = value => (String(value ?? '').trim() === '' ? 'unset' : 'set')
  if (config.jev.decider === 'chat') {
    return `on, chat decider: text model ${config.jev.textModel.model || '(unset)'} at ${config.jev.textModel.baseURL || '(unset)'}, key ${key(config.jev.textModel.apiKey)}`
  }
  return `on, typesafe decider: ${config.jev.typesafe.baseURL || 'default endpoint'} (model ${config.jev.typesafe.model || 'default'}), key ${key(config.jev.typesafe.apiKey)}; text model ${config.jev.textModel.model || '(unset)'} at ${config.jev.textModel.baseURL || '(unset)'}, key ${key(config.jev.textModel.apiKey)}`
}
