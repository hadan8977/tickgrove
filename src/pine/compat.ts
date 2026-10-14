import { Context } from 'pinets'
import { parseExpressionAt } from 'acorn'

const installed = Symbol.for('tradingdashboard.pinets.0.11.1.namedPrimitiveMethods')

/**
 * PineTS 0.11.1 lowers method keyword arguments to a trailing object but
 * Context.call passes that object as the first positional argument. Bind only
 * unambiguous, fully typed primitive methods. Keep Pine source unchanged.
 * Remove this shim when upgrading to an upstream version with this regression fixed.
 */
export function installPineCompatibility() {
  const prototype = Context.prototype as Context & { [installed]?: boolean }
  if (prototype[installed]) return
  const call = prototype.call
  const signatures = new WeakMap<Function, { name: string; optional: boolean }[]>()
  prototype.call = function(fn: Function, id: string, ...args: any[]) {
    const method = fn as Function & { __pineMethod__?: boolean; __pineParamTypes__?: Record<string, string> }
    const tail = args.at(-1)
    const types = method.__pineParamTypes__
    if (args.length > 1 && method.__pineMethod__ && types && tail && Object.getPrototypeOf(tail) === Object.prototype) {
      let signature = signatures.get(fn)
      if (!signature) {
        const expression = parseExpressionAt(Function.prototype.toString.call(fn), 0, { ecmaVersion: 'latest' })
        if (expression.type === 'FunctionExpression' || expression.type === 'ArrowFunctionExpression') {
          signature = expression.params.map(p => ({ name: p.type === 'Identifier' ? p.name : p.type === 'AssignmentPattern' && p.left.type === 'Identifier' ? p.left.name : '', optional: p.type === 'AssignmentPattern' }))
          signatures.set(fn, signature)
        }
      }
      const params = signature?.map(p => p.name)
      const primitives = new Set(['int', 'float', 'bool', 'string', 'color'])
      if (params && params.every(p => /^[\w$]+$/.test(p)) && params.slice(1).every(p => primitives.has(types[p]))) {
        const positional = args.slice(0, -1)
        for (const key of Object.keys(tail)) {
          const index = params.indexOf(key)
          if (index < 1) throw new Error(`Unknown named method argument: ${key}`)
          if (index < positional.length) throw new Error(`Method argument supplied twice: ${key}`)
        }
        args = params.map((name, i) => {
          if (i < positional.length) return positional[i]
          if (Object.prototype.hasOwnProperty.call(tail, name)) return this.param(tail[name], undefined, `${id}:named:${name}`)
          if (!signature![i].optional) throw new Error(`Missing method argument: ${name}`)
          return undefined // Let the compiled function apply its declared default.
        })
      }
    }
    return call.call(this, fn, id, ...args)
  }
  prototype[installed] = true
}
