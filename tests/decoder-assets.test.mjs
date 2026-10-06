import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DECODER_ASSETS,verifiedDecoderAsset} from '../src/decoder-assets.js';
import {MediaDecoder} from '../src/decoder.js';

test('decoder manifest matches both shipped files and rejects truncated or modified bytes',async()=>{
  for(const asset of DECODER_ASSETS){
    const bytes=await readFile(new URL(asset.path,new URL('../src/decoder-assets.js',import.meta.url)));
    assert.equal(await verifiedDecoderAsset(asset,new Blob([bytes])),true);
    assert.equal(await verifiedDecoderAsset(asset,new Blob([bytes.subarray(1)])),false);
    bytes[0]^=1;assert.equal(await verifiedDecoderAsset(asset,new Blob([bytes])),false);
  }
});

test('worker errors settle all pending RPC calls and release the worker immediately',async()=>{
  const original=globalThis.Worker;let terminated=0,worker;
  globalThis.Worker=class{constructor(){worker=this;}postMessage(){}terminate(){terminated++;}};
  const decoder=new MediaDecoder([new Blob(['core']),new Blob(['wasm'])]);
  try{
    const loading=decoder.load(),writing=decoder.writeFile('a',new Uint8Array([1]));
    worker.onerror({preventDefault(){}});
    for(const promise of [loading,writing])await assert.rejects(promise,e=>e.name==='LocalCheckUnavailable'&&e.decoderDiagnostic.code==='script-error');
    assert.equal(decoder.pending.size,0);assert.equal(decoder.loaded,false);assert.equal(terminated,1);
  }finally{decoder.terminate();globalThis.Worker=original;}
});
