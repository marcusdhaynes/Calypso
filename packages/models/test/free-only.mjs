import assert from 'node:assert/strict';
import {DefaultModelRouter} from '../dist/router/model-router.js';
import {toPublicSettings} from '../dist/frontier/settings.js';
const router=new DefaultModelRouter({cloudModelsEnabled:true});
router.registerProvider({id:'ollama'});router.registerProvider({id:'openai'});router.registerProvider({id:'paid-provider'});
router.setRoute('normal','ollama','lfm2.5:8b');router.setRoute('frontier','openai','paid-model');
router.setCloudModelsEnabled(true);
for(const preference of [undefined,'openai/paid-model','paid-provider/paid-model','ollama/paid:cloud']){
 const result=await router.resolve('frontier',preference);assert.equal(result.provider.id,'ollama');assert.equal(result.model,'lfm2.5:8b');
}
const settings=toPublicSettings({cloudModelsEnabled:true,frontier:{enabled:true,apiKey:'test-only-not-a-real-key'}});
assert.equal(settings.public.cloudModelsEnabled,false);assert.equal(settings.public.hasCloudApiKey,false);assert.equal(settings.stored.frontier.apiKey,undefined);
console.log('Free-only native routing and legacy-settings checks passed.');
