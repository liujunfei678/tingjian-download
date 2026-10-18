import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedUI } from '../extension/lib/access.js';
test('only exact extension UI documents may request native file operations',()=>{
  const base='chrome-extension://abcdefgh/';
  for(const url of [base+'panel/panel.html',base+'popup/popup.html']) assert.equal(isTrustedUI({url},base),true);
  for(const url of ['https://example.test/panel/panel.html',base+'panel/evil.html',base+'panel/panel.html/evil',base+'content.js','chrome-extension://other/panel/panel.html',undefined]) assert.equal(isTrustedUI({url},base),false);
});
