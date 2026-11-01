import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initArtifact, validateArtifact, verifyArtifacts } from '../lib/artifacts.mjs';
import { emitPacket } from '../lib/emit/index.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { loadProfile } from '../lib/profile.mjs';
import { enableModules } from '../lib/modules.mjs';
import { addStore, initStore } from '../lib/stores.mjs';

const profile={name:'artifact-lab',idea:'A project used to verify that VLD delivery artifacts are generated and validated as structured evidence.',kind:'web-app',stage:'mvp',constraints:{team:2,weeks:4,stack:'typescript',mustUse:[]}};
function compile(project) {
 const profilePath=path.join(project,'profile.json'); const loaded=loadProfile(profilePath); assert.deepEqual(loaded.errors,[]);
 const plan=buildPlan(loaded.profile,{index:buildIndex(),profileDir:project}); return emitPacket(plan,path.join(project,'specs'));
}
test('artifact templates require modules, preserve deterministic paths and fail strict validation until authored', (t)=>{
 const project=mkdtempSync(path.join(os.tmpdir(),'vld-artifact-'));t.after(()=>rmSync(project,{recursive:true,force:true}));
 writeFileSync(path.join(project,'profile.json'),JSON.stringify(profile)); enableModules({projectDir:project,ids:'qa'});
 const created=initArtifact({kind:'qa-plan',projectDir:project}); assert.match(created.file,/docs[\\/]qa-plan\.md$/);
 const loose=validateArtifact({kind:'qa-plan',projectDir:project}); assert.equal(loose.ok,false,'QA needs a packet even while authoring'); assert.match(loose.warnings.join('\n'),/placeholder/);
 const strict=validateArtifact({kind:'qa-plan',projectDir:project,strict:true}); assert.equal(strict.strictOk,false);
 assert.throws(()=>initArtifact({kind:'architecture-decision',projectDir:project}),/needs a kebab-case decision id/);
 assert.match(readFileSync(created.file,'utf8'),/## Requirement Coverage/);
});

test('a verified store can supply only its declared matching artifact template, with provenance retained', (t) => {
 const root=mkdtempSync(path.join(os.tmpdir(),'vld-artifact-store-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const project=path.join(root,'project'), source=path.join(root,'source'); mkdirSync(project); writeFileSync(path.join(project,'profile.json'),JSON.stringify(profile)); enableModules({projectDir:project,ids:'product'});
 initStore({directory:source,id:'brief-library',title:'Brief library'});
 writeFileSync(path.join(source,'brief.md'),'# Product Brief: shared\n\n**Status:** Draft\n\n## Problem\n\n[Describe the user problem.]\n');
 const manifest=JSON.parse(readFileSync(path.join(source,'vld-store.json'),'utf8')); manifest.assets.push({id:'shared-product-brief',kind:'artifact-template',artifact:'product-brief',file:'brief.md'}); writeFileSync(path.join(source,'vld-store.json'),JSON.stringify(manifest));
 execFileSync('git',['init','-q'],{cwd:source});execFileSync('git',['config','user.email','test@example.com'],{cwd:source});execFileSync('git',['config','user.name','Test'],{cwd:source});execFileSync('git',['add','.'],{cwd:source});execFileSync('git',['commit','-q','-m','template'],{cwd:source});
 addStore({projectDir:project,id:'brief-library',repository:`file://${source}`});
 const imported=initArtifact({kind:'product-brief',projectDir:project,fromStore:'brief-library/shared-product-brief'});
 assert.equal(imported.source.store,'brief-library'); assert.match(readFileSync(imported.file,'utf8'),/VLD template source: brief-library\/shared-product-brief/);
 enableModules({projectDir:project,ids:'qa'});
 assert.throws(()=>initArtifact({kind:'qa-plan',projectDir:project,fromStore:'brief-library/shared-product-brief'}),/not qa-plan/);
});

test('cross-artifact verification enforces strict review and QA traceability against one compiled packet', (t) => {
 const project=mkdtempSync(path.join(os.tmpdir(),'vld-artifact-verify-'));t.after(()=>rmSync(project,{recursive:true,force:true}));
 writeFileSync(path.join(project,'profile.json'),JSON.stringify(profile)); compile(project); enableModules({projectDir:project,ids:'review,qa'});
 const requirements=JSON.parse(readFileSync(path.join(project,'specs','spec.json'),'utf8')).requirements;
 const ids=requirements.map((requirement)=>requirement.id); mkdirSync(path.join(project,'docs'));
 writeFileSync(path.join(project,'docs','review-brief.md'),`# Review Brief: artifact-lab\n\n**Status:** Approved\n\n## Change Summary\n\nThe release evidence was reviewed against the compiled packet and risk boundary.\n\n## Requirements Under Review\n\n${ids.map((id)=>`- ${id}`).join('\n')}\n\n## Risk and Invariants\n\nThe system preserves its documented acceptance criteria and denial paths.\n\n## Evidence\n\nThe packet verification command completed with no findings before review.\n\n## Review Questions\n\nDoes every changed requirement have evidence that would fail on regression?\n\n## Decision\n\nApproved after the accountable reviewer checked the linked evidence.\n`);
 writeFileSync(path.join(project,'docs','qa-plan.md'),`# QA Plan: artifact-lab\n\n**Status:** Approved\n\n## Risk-based Strategy\n\nAutomated requirements receive executable coverage before release approval.\n\n## Requirement Coverage\n\n| Requirement | Test level | Evidence | Status |\n| --- | --- | --- | --- |\n${requirements.filter((requirement)=>requirement.verify==='automated').map((requirement)=>`| ${requirement.id} | integration | tests/${requirement.id}.test.mjs | passed |`).join('\n')}\n\n## End-to-End Scenarios\n\n### Authorized completion\n\n- Given: a valid user and a configured record\n- When: they complete the primary flow\n- Then: the required outcome and audit evidence are visible\n\n## Release Evidence\n\nPacket verification and the linked automated suite completed before approval.\n`);
 const report=verifyArtifacts({projectDir:project,kinds:['review-brief','qa-plan']}); assert.equal(report.ok,true,report.errors.join('\n')); assert.ok(report.passes.some((pass)=>/artifact/.test(pass)));
 const automatedId=ids.find((id)=>requirements.find((requirement)=>requirement.id===id&&requirement.verify==='automated'));
 writeFileSync(path.join(project,'docs','qa-plan.md'),readFileSync(path.join(project,'docs','qa-plan.md'),'utf8').replace(automatedId,'REQ-999'));
 const failed=verifyArtifacts({projectDir:project,kinds:['review-brief','qa-plan']}); assert.equal(failed.ok,false); assert.match(failed.errors.join('\n'),/not in the packet|QA coverage is missing automated/);
});
