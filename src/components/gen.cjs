const fs = require('fs');
const d = String.fromCharCode(36);
const lines = [
  'line1',
  'line2 with ' + d + '{test}',
  'line3 with => arrow'
];
fs.writeFileSync('C:\\Users\\Cyrhiel\\Documents\\INVENTIONS\\AI-Forge\\src\\components\\test_out.txt', lines.join('\r\n'), 'utf8');
console.log('Done:', lines.length, 'lines');