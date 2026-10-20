'use strict'
class OperationError extends Error {
  constructor (code, message, details, status) {
    super(message)
    this.code = code
    if (details !== undefined) this.details = details
    if (status !== undefined) this.status = status
    if (code === 'USAGE') this.exitCode = 2
  }
}
const usage = message => new OperationError('USAGE', message)
module.exports = { OperationError, usage }
