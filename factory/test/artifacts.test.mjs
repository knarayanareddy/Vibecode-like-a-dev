import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initArtifact, validateArtifact } from '../lib/artifacts.mjs';
import { enableModules } from '../lib/modules.mjs';
import { addStore, initStore } from '../lib/stores.mjs';

const profile={name:'artifact-lab',idea:'A project used to verify that VLD delivery artifacts are generated and validated as structured evidence.',kind:'web-app',stage:'mvp',constraints:{team:2,weeks:4,stack:'typescript',mustUse:[]}};
test('artifact templates require modules, preserve deterministic paths and fail strict validation until authored', (t)=>{
 const project=mkdtempSync(path.join(os.tmpdir(),'vld-artifact-'));t.after(()=>rmSync(project,{recursive:true,force:true}));
 writeFileSync(path.join(project,'profile.json'),JSON.stringify(profile)); enableModules({projectDir:project,ids:'qa'});
 const created=initArtifact({kind:'qa-plan',projectDir:project}); assert.match(created.file,/docs\/qa-plan\.md$/);
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
