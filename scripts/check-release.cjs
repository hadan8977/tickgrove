// Completion is deliberately strict: an external dependency is not a pass.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'docs/features/checklist.json'), 'utf8'));
const ids = new Set();
for (const item of catalog.features) {
  if (ids.has(item.id)) throw Error('Duplicate feature: ' + item.id);
  ids.add(item.id);
  if (item.status === 'verified' && (!item.evidence.length || item.evidence.some(p => !fs.existsSync(path.join(root, p))))) {
    throw Error('Missing verification evidence: ' + item.id);
  }
}
const incomplete = catalog.features.filter(f => f.required && f.status !== 'verified');
console.log(JSON.stringify({ required: catalog.features.filter(f => f.required).length, verified: catalog.features.filter(f => f.required && f.status === 'verified').length, incomplete: incomplete.map(({id, feature, status}) => ({id, feature, status})) }, null, 2));
process.exitCode = incomplete.length ? 1 : 0;
