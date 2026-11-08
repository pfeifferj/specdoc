const Ajv = require('ajv')

const RESPONSE_FORMATS = ['json_schema', 'json_object']
const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const ajv = new Ajv({ strict: true, ownProperties: true })

function modelOptions (bot) {
  const response_format = bot.response_format == null || bot.response_format === '' ? 'json_schema' : bot.response_format
  const reasoning_effort = bot.reasoning_effort == null || bot.reasoning_effort === '' ? null : bot.reasoning_effort
  if (!RESPONSE_FORMATS.includes(response_format)) throw new Error('Unsupported model response format')
  if (reasoning_effort !== null && !REASONING_EFFORTS.includes(reasoning_effort)) throw new Error('Unsupported model reasoning effort')
  return { response_format, reasoning_effort }
}

function jsonRequest (bot, system, user, name, schema, maxTokens) {
  const options = modelOptions(bot)
  const validate = ajv.compile(schema)
  const prompt = options.response_format === 'json_object'
    ? system + '\n\nReturn only a JSON object matching this schema:\n' + JSON.stringify(schema)
    : system
  return {
    payload: {
      model: bot.model, temperature: 0.2, max_tokens: maxTokens,
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: user }],
      response_format: options.response_format === 'json_object'
        ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name, schema } },
      ...(options.reasoning_effort === null ? {} : { reasoning_effort: options.reasoning_effort })
    },
    validate (result) {
      if (!validate(result)) throw new Error('Model result does not match the requested schema')
      return result
    }
  }
}

module.exports = { RESPONSE_FORMATS, REASONING_EFFORTS, modelOptions, jsonRequest }
