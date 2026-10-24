import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as api from '../extension/lib/music-sites.js';

const sources = {
  kuwo: 'https://other-web-ra01-sycdn.kuwo.cn/resource/obj_test.mp3?sign=a%2Bb',
  qq: 'https://ws6.stream.qqmusic.qq.com/C400004song.m4a?vkey=a%2Bb&guid=1',
  kugou: 'https://webfs.ali.kugou.com/20261020/obj_test.mp3?token=a%2Bb'
};
const node = (textContent = '', attrs = {}, children = {}) => ({textContent, getAttribute: key => attrs[key] ?? null, querySelector: key => children[key] || null});
const media = url => Object.assign(node('', {src:url}), {currentSrc:url, readyState:1, error:null});
function fixture(site) {
  const audio = media(sources[site]);
  const window = {};
  let root;
  if (site === 'kuwo') root = node('', {}, {
    audio, '.song_name':node('两只老虎'), '.artist':node(' - 贝乐虎'),
    'a[href*="/play_detail/"]':node('', {href:'/play_detail/123456'})
  });
  if (site === 'qq') {
    root = node();
    root.__reactFiber$test = {return:{stateNode:{state:{playSong:{mid:'0013YCAQ1mjISE',name:'摇篮曲',singer:[{name:'甲'},{name:'乙'}]},currentMid:'0013YCAQ1mjISE'},
      player:{currentMid:'0013YCAQ1mjISE',playUrlMap:{'0013YCAQ1mjISE':sources.qq}}}}};
  }
  if (site === 'kugou') {
    audio.getAttribute = key => ({src:sources.kugou,'data-hash':'a'.repeat(32)})[key] ?? null;
    window.play = {globalParam:{song_info:{hash:'a'.repeat(32),song_name:'免费儿歌',author_name:'歌手',play_url:sources.kugou}}};
  }
  const document = {querySelector: selector => ({'.playControl .con_l':root,'.playControl audio':audio,'.mod_player':root,'#myAudio':audio})[selector] || null};
  return {site,window,document,audio,root,href:{kuwo:'https://www.kuwo.cn/',qq:'https://y.qq.com/n/ryqq_v2/player',kugou:'https://www.kugou.com/song/#abc'}[site]};
}
function read(f = fixture('kuwo')) {
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${api.readMusicSitePlayback.toString()})()`,{window:f.window,document:f.document,location:new URL(f.href),URL},{timeout:1000})));
}

test('host routing allows only observed desktop origins, without credentials',()=>{
  for (const [host,site] of [['kuwo.cn','kuwo'],['www.kuwo.cn','kuwo'],['y.qq.com','qq'],['www.kugou.com','kugou'],['kugou.com','kugou']]) assert.equal(api.musicSiteForURL('https://'+host+'/'),site);
  for (const href of ['https://kuwo.cn.evil.test/','https://evil.qq.com/','https://evil.test/','https://constructor/','ftp://www.kugou.com/','https://u:p@y.qq.com/',null]) assert.equal(api.musicSiteForURL(href),'');
});

test('serialized Kuwo reader uses the current footer song and loaded audio, not page title',()=>{
  assert.deepEqual(read(),[{site:'kuwo',trackId:'123456',title:'两只老虎',artist:'贝乐虎',url:sources.kuwo}]);
});

test('Kuwo source transition, media errors, empty song and non-song links remain unnamed',()=>{
  for (const change of [f=>f.audio.currentSrc+='old',f=>f.audio.readyState=0,f=>f.audio.error={code:4},f=>f.root.querySelector('.song_name').textContent='',f=>f.root.querySelector('a[href*="/play_detail/"]').getAttribute=()=>'/playlist_detail/123']) {
    const f=fixture('kuwo');change(f);assert.deepEqual(read(f),[]);
  }
});

test('QQ reads only a current player ancestor and exact mid URL map entry',()=>{
  const f=fixture('qq'); assert.deepEqual(read(f),[{site:'qq',trackId:'0013YCAQ1mjISE',title:'摇篮曲',artist:'甲 / 乙',url:sources.qq}]);
  const instance=f.root.__reactFiber$test.return.stateNode;
  instance.player.currentMid='anotherSong';assert.deepEqual(read(f),[]);
  instance.player.currentMid='0013YCAQ1mjISE';instance.state.currentMid='anotherSong';assert.deepEqual(read(f),[]);
});

test('QQ getter, arbitrary descendants and cyclic fiber pointers are never traversed',()=>{
  const f=fixture('qq');let calls=0;
  Object.defineProperty(f.root.__reactFiber$test.return.stateNode.player,'playUrlMap',{get(){calls++;throw Error();}});
  assert.deepEqual(read(f),[]);assert.equal(calls,0);
  f.root.__reactFiber$test={};f.root.__reactFiber$test.return=f.root.__reactFiber$test;
  assert.deepEqual(read(f),[]);
  f.root.__reactFiber$test={child:fixture('qq').root.__reactFiber$test};assert.deepEqual(read(f),[]);
});

test('Kugou binds song_info to the actual audio hash and URL',()=>{
  const f=fixture('kugou');assert.deepEqual(read(f),[{site:'kugou',trackId:'a'.repeat(32),title:'免费儿歌',artist:'歌手',url:sources.kugou}]);
  f.window.play.globalParam.song_info.hash='b'.repeat(32);assert.deepEqual(read(f),[]);
  f.window.play.globalParam.song_info.hash='a'.repeat(32);f.window.play.globalParam.song_info.play_url+='different';assert.deepEqual(read(f),[]);
});

test('Kugou backup playback may match, but a new source before media load may not',()=>{
  const f=fixture('kugou');const song=f.window.play.globalParam.song_info;
  song.play_backup_url=song.play_url;song.play_url=song.play_url.replace('obj_test','primary');
  assert.equal(read(f)[0].url,sources.kugou);
  f.audio.currentSrc=song.play_url;assert.deepEqual(read(f),[]);
});

test('all adapters reject spoofed origins, credentials and nonaudio sources',()=>{
  for (const site of ['kuwo','qq','kugou']) {
    const f=fixture(site);f.href='https://evil.test/';assert.deepEqual(read(f),[]);
    const authenticated=fixture(site);authenticated.href=authenticated.href.replace('https://','https://user:pass@');assert.deepEqual(read(authenticated),[]);
    for (const url of ['https://evil.test/a.mp3','blob:https://www.kuwo.cn/id','https://ws6.stream.qqmusic.qq.com/a.m3u8','https://webfs.ali.kugou.com/a.mp4','https://user:pass@webfs.ali.kugou.com/a.mp3']) {
      const v=fixture(site);v.audio.currentSrc=url;v.audio.getAttribute=key=>key==='src'?url:key==='data-hash'?'a'.repeat(32):null;
      if(site==='qq')v.root.__reactFiber$test.return.stateNode.player.playUrlMap['0013YCAQ1mjISE']=url;
      if(site==='kugou')v.window.play.globalParam.song_info.play_url=url;
      assert.deepEqual(read(v),[],site+': '+url);
    }
  }
});

test('missing players and unknown own getters do not run or produce resource bindings',()=>{
  for(const site of ['kuwo','qq','kugou']) {
    const f=fixture(site);f.document={querySelector:()=>null};assert.deepEqual(read(f),[]);
  }
  const f=fixture('kugou');let calls=0;
  Object.defineProperty(f.window,'play',{get(){calls++;throw Error();}});
  assert.deepEqual(read(f),[]);assert.equal(calls,0);
});
