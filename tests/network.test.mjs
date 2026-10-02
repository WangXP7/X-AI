import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionError,networkRecord,taskProblem} from '../src/network.js';
import {queueProgress} from '../src/queue-progress.js';
test('network errors identify operation without pretending fetch proved CORS',()=>{
  const e=new ConnectionError('media','direct',new TypeError('Failed to fetch'));
  assert.match(e.message,/下载视频失败/);assert.match(e.message,/服务端已生成/);assert.match(e.message,/网络或跨域/);
  assert.deepEqual(Object.keys(networkRecord(e)),['at','operation','connection','code','message']);
  assert.match(new ConnectionError('submit','direct',new TypeError('fetch')).message,/不能重复提交/);
  assert.match(new ConnectionError('poll','direct',{name:'TimeoutError'}).message,/超时/);
  assert.match(new ConnectionError('media','bridge',{status:403}).message,/配对码/);
});
test('completed service task blocked on download stays distinct from failed generation',()=>{
  const job={id:'S01',state:'blocked',error:'旧泛化网络提示',attempts:[{videoId:'keep-id',url:'https://cdn.example.test/video.mp4',pollResponse:{status:'completed',progress:100}}]};
  const issue=taskProblem(job);assert.equal(issue.downloadPending,true);assert.equal(issue.stage,3);assert.match(issue.label,/已生成.*下载/);
  const p=queueProgress({jobs:[job]},{});assert.equal(p.stage,3);assert.equal(p.ready,0);assert.equal(p.percent,null);assert.equal(p.attention,1);assert.match(p.warning,/网页下载未完成/);
  job.attempts[0].rawBlobKey='downloaded';assert.equal(taskProblem(job).stage,4);assert.equal(taskProblem(job).downloadPending,false);
  job.state='failed';assert.equal(taskProblem(job).label,null);
});
