import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverDownloads,downloadDelay,shouldRefreshLink} from '../src/download-recovery.js';
test('only known completed media failures migrate to automatic recovery',()=>{
 const make=()=>({state:'blocked',error:'old',attempts:[{url:'https://example.test/video.mp4',videoId:'original',lastProblem:{operation:'media'}}]});
 const jobs=[make(),make(),make(),make()];jobs[1].attempts[0].rawPath='raw/saved.mp4';jobs[2].attempts[0].lastProblem.operation='poll';jobs[3].attempts[0].downloadPermanent=true;
 assert.equal(recoverDownloads({jobs}),1);assert.equal(jobs[0].state,'download');assert.equal(jobs[0].error,null);assert.equal(jobs[0].attempts.length,1);assert.equal(jobs[1].state,'blocked');
});
test('bounded retry interval and original-task link refresh avoid query storms',()=>{
 assert.equal(downloadDelay(1),15000);assert.equal(downloadDelay(999),300000);
 const a={videoId:'original',downloadFailures:1};assert.equal(shouldRefreshLink(a,{status:403},1000000),true);a.downloadLinkCheckedAt=999999;assert.equal(shouldRefreshLink(a,{status:403},1000000),false);assert.equal(shouldRefreshLink({}, {status:403},1000000),false);
});
