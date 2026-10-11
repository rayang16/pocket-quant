import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSharedReel,sharedInput} from '../public/shared-reel.js';
test('iPhone shortcut decodes a URL once and removes Instagram tracking',()=>{
  const link='https://www.instagram.com/reel/AbC_123-x/?igsh=secret';
  const received=sharedInput(new URL('https://example.com/#shared='+encodeURIComponent(link)));
  assert.deepEqual(parseSharedReel(received),{url:'https://www.instagram.com/reel/AbC_123-x/'});
});
test('handles share text and post permalinks without treating surrounding words as a claim',()=>{
  assert.deepEqual(parseSharedReel('Watch this! https://instagram.com/p/AbC/.'),{url:'https://www.instagram.com/p/AbC/'});
  assert.equal(parseSharedReel('https://m.instagram.com/reels/ABC/').url,'https://www.instagram.com/reel/ABC/');
});
test('rejects spoofed, executable, malformed, oversized and multiple links',()=>{
  for(const value of ['https://instagram.com.evil.com/reel/abc/','https://instagram.com@evil.com/reel/abc/','https://evil@instagram.com/reel/abc/','http://instagram.com/reel/abc/','https://www.instagram.com:444/reel/abc/','javascript:alert(1)','https://instagram.com/direct/inbox/','x'.repeat(12001),'https://instagram.com/reel/abc/ https://instagram.com/reel/def/']) assert.ok(parseSharedReel(value).error,value.slice(0,100));
});
test('ordinary app launches are distinct from empty shares; supports share target query fields',()=>{
  assert.equal(sharedInput(new URL('https://example.com/')),null);
  assert.equal(sharedInput(new URL('https://example.com/#shared=')),'');
  assert.equal(parseSharedReel(sharedInput(new URL('https://example.com/?text='+encodeURIComponent('https://instagram.com/reel/abc/')))).url,'https://www.instagram.com/reel/abc/');
});
