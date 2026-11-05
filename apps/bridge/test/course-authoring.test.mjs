import test from 'node:test';
import assert from 'node:assert/strict';
import {isCourseProject,courseInstructions,courseMinimumFiles} from '../course-authoring.mjs';

test('recognizes explicit academic production without triggering ordinary plans',()=>{
  assert.equal(isCourseProject({name:'Jurisprudence',description:'Create a complete college course and textbook'}),true);
  assert.equal(isCourseProject({name:'Engineering',description:'Write a university syllabus'}),true);
  assert.equal(isCourseProject({name:'Product launch',description:'Determine the best course of action'}),false);
  assert.equal(isCourseProject({name:'Fix browser',description:'Improve tabs'}),false);
});
test('all academic roles have independently actionable instructions',()=>{
  for(const role of ['coordinator','researcher','writer','reviewer']){
    const prompt=courseInstructions(role);
    assert.match(prompt,/Do NOT ask|do NOT ask/i);
    assert.match(prompt,/source/i);
    assert.ok(prompt.length>1500);
  }
  assert.match(courseInstructions('writer'),/BOOK\.html/);
  assert.match(courseInstructions('reviewer'),/NEEDS_CHANGES/);
  assert.match(courseInstructions('researcher'),/BLOCKED/);
});
test('required outputs cover content, evidence, assessment and design',()=>{
  const filenames=courseMinimumFiles();
  assert.deepEqual(new Set(filenames).size,filenames.length);
  for(const filename of ['BOOK.md','BOOK.html','SOURCES.md','ASSESSMENTS.md','REVIEW.md'])assert.ok(filenames.includes(filename));
});
