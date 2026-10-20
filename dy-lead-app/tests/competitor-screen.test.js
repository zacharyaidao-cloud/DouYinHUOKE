'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { competitorReason } = require('../lib/competitor-screen');
const { aiExclusionReason } = require('../lead-query');

// 样本取自 2026-10-21 实测采集的近 3 天评论（昵称/评论原文）
const sellers = [
  ['程风破破浪', '视频失败，能接么'], ['路明非', '视频认证失败，什么价位。'], ['知意-', '扫号侵权呢？什么价格'],
  ['今天你摔车了吗？', '怎么联系'], ['西红柿的马铃薯', '如何激活呀'], ['做好自己', '我的申诉四年了'], ['是承宸呀', '需要'],
  ['嗯嗯嗯！', '协议三法人问题没有回答上来 认证不通过'], ['某卖家', '我们有两个店被停用了怎么办']
];
const competitors = [
  ['亚马逊全能小金', '可以处理'], ['D.Rose', '侵权协议三能接'], ['超级6-Maggie麦麦', '这边发您份题库，先作为参考吧'],
  ['超级6～Ellie', 'p4二审已经完全突破'], ['AMZ-亚马逊全球服务', '有需要随时欢迎滴滴'], ['职前跨境申诉-芝芝', '二审，法人能配合吗？可以申诉的'],
  ['亚马逊收店铺清库存', '收'], ['风軒', '回收店铺'], ['乐意李💛', '出店'], ['知犀小徐｜视频认证', '账单都有吗']
];

test('真实卖家的求助评论不被当成同行', () => {
  for (const [nickname, demand] of sellers) assert.equal(competitorReason({ nickname, demand }), '', nickname + '：' + demand);
});

test('服务商昵称与揽客话术被识别为同行，并在 AI 与触达前排除', () => {
  for (const [nickname, demand] of competitors) {
    assert.match(competitorReason({ nickname, demand }), /^同行\/服务商/, nickname + '：' + demand);
    assert.match(aiExclusionReason({ nickname, demand, uid: 'x', videoLink: 'https://www.douyin.com/video/1' }), /^同行\/服务商/);
  }
});
