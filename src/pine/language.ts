import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import type { CompletionContext, Completion } from '@codemirror/autocomplete'

const KEYWORDS = /^(if|else|for|to|by|while|switch|var|varip|and|or|not|true|false|na|import|export|method|type|return|break|continue)\b/
const DECL = /^(indicator|strategy|library)\b/
const NS = /^(ta|math|strategy|input|color|str|array|request|syminfo|timeframe|plot|plotshape|hline|fill|bgcolor|barcolor|alertcondition)\b/
const BUILTIN_VARS = /^(open|high|low|close|volume|hl2|hlc3|ohlc4|bar_index|time)\b/

export const pineLanguage = StreamLanguage.define<{ inString: false | string }>({
  name: 'pine',
  startState: () => ({ inString: false }),
  token(stream, state) {
    if (state.inString) {
      while (!stream.eol()) {
        if (stream.next() === state.inString) {
          state.inString = false
          break
        }
      }
      return 'string'
    }
    if (stream.eatSpace()) return null
    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }
    const ch = stream.peek()
    if (ch === '"' || ch === "'") {
      state.inString = stream.next() as string
      return 'string'
    }
    if (stream.match(/^#[0-9a-fA-F]{6,8}\b/)) return 'color'
    if (stream.match(/^\d+(\.\d+)?/)) return 'number'
    if (stream.match(DECL)) return 'definitionKeyword'
    if (stream.match(KEYWORDS)) return 'keyword'
    if (stream.match(NS)) return 'namespace'
    if (stream.match(BUILTIN_VARS)) return 'variableName.special'
    if (stream.match(/^[a-zA-Z_]\w*(?=\s*\()/)) return 'function'
    if (stream.match(/^[a-zA-Z_]\w*/)) return 'variableName'
    if (stream.match(/^(:=|==|!=|>=|<=|=>|\?|:|[+\-*/%<>=])/)) return 'operator'
    stream.next()
    return null
  },
  languageData: { commentTokens: { line: '//' } },
  tokenTable: { color: tags.color, namespace: tags.namespace, function: tags.function(tags.variableName), definitionKeyword: tags.definitionKeyword },
})

export const pineHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.comment, color: 'var(--faint)', fontStyle: 'italic' },
    { tag: tags.string, color: 'var(--up)' },
    { tag: tags.number, color: 'var(--demo)' },
    { tag: tags.color, color: 'var(--accent-2)' },
    { tag: tags.keyword, color: 'var(--accent)', fontWeight: '500' },
    { tag: tags.definitionKeyword, color: 'var(--accent)', fontWeight: '600' },
    { tag: tags.namespace, color: 'var(--accent-2)' },
    { tag: tags.function(tags.variableName), color: 'var(--text)', fontWeight: '500' },
    { tag: tags.special(tags.variableName), color: '#f472b6' },
    { tag: tags.variableName, color: 'var(--text)' },
    { tag: tags.operator, color: 'var(--muted)' },
  ]),
)

const fn = (label: string, detail: string, info?: string): Completion => ({ label, detail, info, type: 'function', apply: label.endsWith(')') ? label : label })
const COMPLETIONS: Completion[] = [
  fn('indicator', '(title, overlay)', 'Declare an indicator script'),
  fn('strategy', '(title, overlay, initial_capital)', 'Declare a strategy script'),
  fn('ta.sma', '(source, length)', 'Simple moving average'),
  fn('ta.ema', '(source, length)', 'Exponential moving average'),
  fn('ta.rma', '(source, length)', 'RSI moving average'),
  fn('ta.wma', '(source, length)', 'Weighted moving average'),
  fn('ta.rsi', '(source, length)', 'Relative strength index'),
  fn('ta.macd', '(source, fast, slow, signal)', 'Returns [macd, signal, hist]'),
  fn('ta.atr', '(length)', 'Average true range'),
  fn('ta.stdev', '(source, length)', 'Standard deviation'),
  fn('ta.highest', '(source, length)', 'Highest value over length'),
  fn('ta.lowest', '(source, length)', 'Lowest value over length'),
  fn('ta.crossover', '(a, b)', 'a crosses above b'),
  fn('ta.crossunder', '(a, b)', 'a crosses below b'),
  fn('ta.change', '(source)', 'Difference from previous bar'),
  fn('ta.bb', '(source, length, mult)', 'Returns [middle, upper, lower]'),
  fn('ta.vwap', '(source)', 'Volume weighted average price'),
  fn('input.int', '(defval, title, minval, maxval)', 'Integer input → settings panel'),
  fn('input.float', '(defval, title, minval, maxval)', 'Float input → settings panel'),
  fn('input.bool', '(defval, title)', 'Boolean input'),
  fn('input.source', '(defval, title)', 'Price source input'),
  fn('plot', '(series, title, color)', 'Plot a series'),
  fn('plotshape', '(condition, title)', 'Plot shapes on condition'),
  fn('hline', '(price, title)', 'Horizontal level'),
  fn('strategy.entry', '(id, direction)', 'Open a position'),
  fn('strategy.close', '(id)', 'Close a position'),
  fn('strategy.exit', '(id, from_entry, stop, limit)', 'Bracket exit'),
  fn('math.abs', '(x)'),
  fn('math.max', '(a, b)'),
  fn('math.min', '(a, b)'),
  { label: 'strategy.long', type: 'constant' },
  { label: 'strategy.short', type: 'constant' },
  { label: 'strategy.position_size', type: 'variable' },
  { label: 'strategy.position_avg_price', type: 'variable' },
  ...['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'bar_index'].map((l) => ({ label: l, type: 'variable', detail: 'series float' })),
  ...['color.red', 'color.green', 'color.blue', 'color.orange', 'color.purple', 'color.gray', 'color.white'].map((l) => ({ label: l, type: 'constant' })),
  ...['if', 'else', 'for', 'var', 'and', 'or', 'not', 'true', 'false', 'na'].map((l) => ({ label: l, type: 'keyword' })),
]

export function pineCompletions(ctx: CompletionContext) {
  const word = ctx.matchBefore(/[\w.]+/)
  if (!word || (word.from === word.to && !ctx.explicit)) return null
  return { from: word.from, options: COMPLETIONS, validFor: /^[\w.]*$/ }
}
