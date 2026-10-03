import test from 'node:test';
import assert from 'node:assert/strict';
import {relayEndpoint} from '../src/media-relay.js';
import {shouldRefreshLink} from '../src/download-recovery.js';
import {taskStatus} from '../src/network.js';
const origin='https://wangxp7.github.io',config={protocol:'x-ai-media-v1',pageOrigins:[origin],endpoint:'http://127.0.0.1:4183/'};
test('automatic discovery uses one explicit loopback endpoint and exact page origin',()=>{
  assert.equal(relayEndpoint(config,origin),config.endpoint);
  assert.equal(relayEndpoint(config,'https://evil.test'),null);
  for(const endpoint of ['http://192.168.1.1:4183/','https://proxy.test/','http://user:pw@127.0.0.1:4183/','http://127.0.0.1:4183/?url=x'])assert.equal(relayEndpoint({...config,endpoint},origin),null);
});
test('unavailable channel neither masquerades as active download nor refreshes same URL repeatedly',()=>{
  assert.equal(taskStatus({state:'download',attempts:[{downloadWaitingFor:'download-channel',downloadRecovery:true}]}),'已生成 · 等待下载通道');
  assert.equal(shouldRefreshLink({videoId:'existing',downloadFailures:55},{code:'media_channel_unavailable'}),false);
  assert.equal(shouldRefreshLink({videoId:'existing',downloadFailures:55},{status:403}),true);
});
