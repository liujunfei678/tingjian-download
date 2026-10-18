import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/lib/audio.js';
const A=globalThis.AudioTools;

test('1.1 filename selection retains original object filename when no player title is available',()=>{
  const raw={url:'https://example.test/obj_w5rDlsOJwrLDjj7Cm.m4a?token=a%2Bb',pageTitle:'音乐合集'};
  assert.equal(A.candidate(raw).filename,'obj_w5rDlsOJwrLDjj7Cm.m4a');
  assert.equal(A.candidate({...raw,title:'恢复的中文歌曲',titleSource:'element'}).filename,'恢复的中文歌曲.m4a');
  assert.equal(A.candidate(raw).url,raw.url);
});

test('1.1 native player descriptors retain Chinese metadata before response format arrives',()=>{
  const player=A.candidate({url:'https://example.test/player/123?token=a%2Bb',source:'page',fromAudioElement:true,title:'中文歌',artist:'歌手',titleSource:'element'});
  assert.equal(player.filename,'中文歌 - 歌手');
  const response=A.candidate({url:player.url,mime:'audio/mp4',source:'network',verified:true});
  assert.equal(A.merge(player,response).filename,'中文歌 - 歌手.m4a');
});
