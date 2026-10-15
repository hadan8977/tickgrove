export interface DependencyRequest { reference?: string; source?: string }
/** UI discovery only; the server's resolver remains the authority for executable imports. */
function codeOnly(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    (part) => part.replace(/[^\n]/g, " "));
}
export function pineDependencies(source: string) {
  return [...codeOnly(source).matchAll(/^import[ \t]+([A-Za-z_]\w*\/[A-Za-z_]\w*\/[1-9]\d*)\b/gm)]
    .map((match) => ({ reference: match[1], line: source.slice(0, match.index).split("\n").length }));
}
export function isPineLibrary(source: string) {
  return /^library\s*\(/m.test(codeOnly(source));
}
export function dependencyFromError(message: string) {
  return message.match(/\b([A-Za-z_]\w*\/[A-Za-z_]\w*\/[1-9]\d*)\b/)?.[1];
}
export function dependencyFields(reference?: string) {
  const match = reference?.match(/^([A-Za-z_]\w*)\/([A-Za-z_]\w*)\/([1-9]\d*)$/);
  return match ? { publisher: match[1], name: match[2], version: Number(match[3]) } : undefined;
}
