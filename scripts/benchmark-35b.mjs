import {main} from '../apps/bridge/benchmark-35b.mjs';
export * from '../apps/bridge/benchmark-35b.mjs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
