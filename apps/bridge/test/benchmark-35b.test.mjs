import {test} from 'node:test';
import assert from 'node:assert/strict';
import {profiles,serverArgs,selectWinner} from '../../../scripts/benchmark-35b.mjs';
test('35B benchmark uses pinned quant file, local endpoint, CPU experts and bounded context',()=>{
 const a=serverArgs(profiles[0],1234);
 for(const [flag,v] of [['--host','127.0.0.1'],['--n-cpu-moe','30'],['--ctx-size','8192'],['--cache-type-v','q8_0']])assert.equal(a[a.indexOf(flag)+1],v);
 assert.match(a[a.indexOf('--hf-file')+1],/UD-IQ4_XS\.gguf$/);
});
test('selection prioritizes accuracy and rejects slow, low memory and failed tools',()=>{
 const good={toolPass:true,mathPass:true,generationPass:true,tokensPerSecond:9,minFreeRamGiB:2,minFreeVramMiB:500};
 const quality={...good,profile:'quality'},compact={...good,profile:'compact',tokensPerSecond:20};
 assert.equal(selectWinner([compact,quality]).profile,'quality');
 assert.equal(selectWinner([{...quality,toolPass:false},compact]).profile,'compact');
 assert.equal(selectWinner([{...quality,tokensPerSecond:4},{...compact,minFreeRamGiB:0.5}]),null);
});
