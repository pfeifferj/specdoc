const Ajv = require('ajv')

const RESPONSE_FORMATS = ['json_schema', 'json_object']
const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const ENDPOINT_MODES = ['base', 'full']
const TOKEN_LIMIT_PARAMETERS = ['max_tokens', 'max_completion_tokens']
const ajv = new Ajv({ strict: true, ownProperties: true })

function modelOptions (bot) {
  const response_format = bot.response_format == null || bot.response_format === '' ? 'json_schema' : bot.response_format
  const reasoning_effort = bot.reasoning_effort == null || bot.reasoning_effort === '' ? null : bot.reasoning_effort
  const endpoint_mode = bot.endpoint_mode == null || bot.endpoint_mode === '' ? 'base' : bot.endpoint_mode
  const temperature = bot.temperature === undefined ? 0.2 : bot.temperature
  const token_limit_parameter = bot.token_limit_parameter == null || bot.token_limit_parameter === '' ? 'max_tokens' : bot.token_limit_parameter
  if (!RESPONSE_FORMATS.includes(response_format)) throw new Error('Unsupported model response format')
  if (reasoning_effort !== null && !REASONING_EFFORTS.includes(reasoning_effort)) throw new Error('Unsupported model reasoning effort')
  if (!ENDPOINT_MODES.includes(endpoint_mode)) throw new Error('Unsupported model endpoint mode')
  if (!TOKEN_LIMIT_PARAMETERS.includes(token_limit_parameter)) throw new Error('Unsupported model token limit parameter')
  if (temperature !== null && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new Error('Model temperature must be a number from 0 to 2, or blank for the provider default')
  }
  return { response_format, reasoning_effort, endpoint_mode, temperature, token_limit_parameter }
}

function modelOptionOverrides (bot) {
  const options = modelOptions(bot)
  return {
    ...(options.response_format !== 'json_schema' || options.reasoning_effort !== null
      ? { response_format: options.response_format, reasoning_effort: options.reasoning_effort } : {}),
    ...(options.endpoint_mode !== 'base' ? { endpoint_mode: options.endpoint_mode } : {}),
    ...(options.temperature !== 0.2 ? { temperature: options.temperature } : {}),
    ...(options.token_limit_parameter !== 'max_tokens' ? { token_limit_parameter: options.token_limit_parameter } : {})
  }
}

function jsonRequest (bot, system, user, name, schema, maxTokens, { responseSchema = schema } = {}) {
  const options = modelOptions(bot)
  const validate = ajv.compile(responseSchema)
  const prompt = options.response_format === 'json_object'
    ? system + '\n\nReturn only a JSON object matching this schema:\n' + JSON.stringify(schema)
    : system
  return {
    options,
    payload: {
      model: bot.model,
      ...(options.temperature === null ? {} : { temperature: options.temperature }),
      [options.token_limit_parameter]: maxTokens,
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: user }],
      response_format: options.response_format === 'json_object'
        ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name, schema } },
      ...(options.reasoning_effort === null ? {} : { reasoning_effort: options.reasoning_effort })
    },
    validate (result) {
      if (!validate(result)) throw Object.assign(new Error('Model result does not match the requested schema'), { code: 'model-output-invalid' })
      return result
    }
  }
}

module.exports = { RESPONSE_FORMATS, REASONING_EFFORTS, ENDPOINT_MODES, TOKEN_LIMIT_PARAMETERS, modelOptions, modelOptionOverrides, jsonRequest }
