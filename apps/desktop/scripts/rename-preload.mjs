import fs from 'node:fs';
for(const suffix of ['', '.map']){const from='dist/preload/index.js'+suffix,to='dist/preload/index.cjs'+suffix;if(fs.existsSync(from))fs.renameSync(from,to);}
