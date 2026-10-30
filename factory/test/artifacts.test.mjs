import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initArtifact, validateArtifact } from '../lib/artifacts.mjs';
import { enableModules } from '../lib/modules.mjs';

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
