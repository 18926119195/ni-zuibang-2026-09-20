const fs = require('fs');
const oldData = JSON.parse(fs.readFileSync('final-noun-index.json', 'utf8'));
const newData = JSON.parse(fs.readFileSync('final-noun-index.json.new', 'utf8'));

const oldIds = new Set(oldData.nouns.map(n => n.id));
const newIds = new Set(newData.nouns.map(n => n.id));

const added = [...newIds].filter(id => !oldIds.has(id));
const removed = [...oldIds].filter(id => !newIds.has(id));

console.log('=== META ===');
console.log('old meta:', JSON.stringify(oldData.meta));
console.log('new meta:', JSON.stringify(newData.meta));
console.log('');
console.log('=== COUNTS ===');
console.log('old nouns count:', oldData.nouns.length);
console.log('new nouns count:', newData.nouns.length);
console.log('added count:', added.length);
console.log('removed count:', removed.length);
console.log('');
console.log('=== SAMPLE ADDED (first 40) ===');
console.log(added.slice(0,40));
console.log('');
console.log('=== SAMPLE REMOVED (first 40) ===');
console.log(removed.slice(0,40));
