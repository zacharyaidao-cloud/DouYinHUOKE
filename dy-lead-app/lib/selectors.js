'use strict';

/**
 * 页面定位规则集中表。抖音网页改版导致“找不到搜索框 / 评论区 / 关注按钮 /
 * 私信入口 / 聊天输入框 / 发送按钮”时，只改这一个文件。
 *
 * 原则：DOM 只负责定位与点击；动作结果与对方身份一律以平台响应为准
 * （见 action-receipts.js、dm-receipt-observer.js、dm-history-observer.js）。
 *
 * 写法约定：
 * - 每一项都是“候选数组”，按顺序尝试；新版本标识加在数组里，旧标识保留到确认下线。
 * - CSS 选择器项：数组成员是选择器，页面里按 join(',') 合并查询，或逐个 matches。
 * - 名称以 Label / Text / Identity 结尾的项是正则源字符串（不含斜杠），任一命中即算。
 *   Identity 类按忽略大小写匹配 id/class/data-e2e/data-testid 的拼接串。
 * - 这些规则会被 Playwright 随页面函数一起序列化进页面，只能是纯 JSON 数据：
 *   不要放函数、RegExp 对象或引用其他模块的值。
 */

const SEARCH = {
  // 首页顶部搜索框：先找平台 data-e2e 标识，再按占位文案找可见输入框。
  input: ['input[data-e2e="searchbar-input"]'],
  inputByPlaceholder: ['input'],
  inputPlaceholderText: ['搜索你感兴趣的内容|搜索'],
  // 搜索按钮；首页收起时点击“搜索”文字展开输入框。
  submitButton: ['button[data-e2e="searchbar-button"]'],
  entryByText: ['span'],
  entryText: ['^搜索$'],
  // 结果页范围页签（视频 / 图文）：优先 ARIA 页签，再按文字找，排除顶部导航与侧栏。
  tab: ['[role="tab"]'],
  tabByText: ['div', 'span', 'a'],
  outsideResults: ['header', 'nav', 'aside', '[role="navigation"]', '[role="banner"]'],
  // 结果流滚动容器候选（取可滚动量最大的一个，回退窗口）。
  feedContainer: ['div', 'main', 'section', 'ul']
};

const COMMENTS = {
  // 评论列表 / 面板区域。
  list: [
    '[data-e2e="comment-list"]', '[data-e2e="comment-list-container"]', '[data-e2e="comment-panel"]',
    '[data-e2e="comment-area"]', '[data-e2e="comment-content"]', '[class*="commentList"]', '[class*="CommentList"]',
    '[class*="comment-list"]', '[role="tabpanel"][id*="comment"]', '[role="region"][aria-label="评论"]'
  ],
  // 单条评论标记；列表标识缺失时由它向上找所在滚动列表。
  item: ['[data-e2e="comment-item"]', '[data-e2e="comment-level-1"]', '[class*="commentItem"]', '[class*="CommentItem"]'],
  itemScope: ['[data-e2e="scroll-list"]', '[role="tabpanel"]', '[role="region"]'],
  // 评论页签（图文作品需先点开）及其文字。
  tab: ['[role="tab"][aria-controls]'],
  tabLabel: ['^评论\\s*(?:[（(]?\\d+(?:\\.\\d+)?[万亿+]?[）)]?)?$'],
  // 评论入口候选元素、要排除的区域、图标标记、可点击祖先。
  entryCandidates: ['[role="tab"]', 'button', 'a', '[data-e2e]', '[aria-label]', '[title]', 'span', 'div', 'svg'],
  entryExcluded: [
    'input', 'textarea', '[contenteditable="true"]', '[data-e2e="video-desc"]', '[data-e2e="video-description"]',
    '[data-e2e="comment-item"]', '[data-e2e="comment-level-1"]', '[class*="commentItem"]', '[class*="CommentItem"]',
    '[data-e2e="comment-input"]'
  ],
  // data-e2e 精确取值（不是选择器）。
  entryIconMarker: ['comment-icon', 'comment-button', 'video-comment', 'feed-comment-icon', 'video-comment-icon'],
  entryInteractive: ['button', 'a', '[role="button"]', '[role="tab"]'],
  tabContainer: ['[role="tablist"]', '[class*="tab"]', '[class*="Tab"]'],
  relatedTabText: ['相关推荐'],
  entryRejectLabel: ['关注|点赞|喜欢|收藏|相关推荐|发送'],
  // 推荐列表：滚动容器一旦包住它，就不再向上找（避免滚推荐流）。
  recommend: ['[data-e2e*="recommend"]', '[class*="recommend-list"]', '[class*="RecommendList"]']
};

const OUTREACH = {
  // 页面上可点击的原生控件。
  controls: ['button', 'a', '[role="button"]'],
  // 推荐、评论、搜索、消息列表等普通内容区域：其中的同名按钮不是目标主页控件。
  ordinaryIdentity: ['recommend|related|suggest|comment|search|message[-_ ]?(?:list|history|bubble|item)|chat[-_ ]?(?:list|history|bubble|item)'],
  // 旧式页面上的显式接收人属性（当前 StackLayout 聊天层不使用）。值是属性名。
  recipientSecUidAttributes: ['data-sec-uid', 'data-sec-user-id', 'data-user-sec-uid', 'data-recipient-sec-uid'],
  recipientUidAttributes: ['data-recipient-uid', 'data-recipient-id'],

  profile: {
    info: ['[data-e2e="user-info"]'],
    name: ['h1'],
    // 关注按钮的平台标识：用来把并列的操作区与 user-info 配对。
    followMarker: ['[data-e2e="user-info-follow-btn"]'],
    scopeIdentity: ['user[-_ ]?(?:info|detail|header|action)|profile[-_ ]?(?:info|detail|header|action)'],
    followLabel: ['^(?:[+＋]\\s*)?(?:关注|回关)$'],
    followedLabel: ['^(?:已关注|关注中|互相关注)$'],
    // 关注后按钮可能被重绘成“已关注/互相关注”且丢失标识：同组内唯一的关注状态控件也可作配对锚点。
    followStateControls: ['button', '[role="button"]'],
    followStateLabel: ['^(?:[+＋]\\s*)?(?:关注|回关|已关注|关注中|互相关注|相互关注)$'],
    dmEntryLabel: ['^(?:私信|发私信|发送私信|发消息|发送消息)$']
  },

  im: {
    // 私信抽屉与其中的堆叠层（会话列表层 / 聊天层）。
    dialog: ['[data-e2e="im-dialog"]'],
    stackLayer: ['[data-stack-layer]'],
    chatLayer: ['[data-stack-layer="chat"]'],
    listLayer: ['[data-stack-layer="list"]'],
    // 聊天层标题栏、对方信息块、对方昵称。
    chatTitleBar: ['.StackLayoutStackTitleBartitleBar'],
    chatHeaderUser: ['.StackLayoutStackTitleBartitleBar .StackLayoutStackChatHeaderinfoContainer .StackLayoutStackChatHeaderuser'],
    chatHeaderTitle: ['.StackLayoutStackChatHeadertitle'],
    // 会话列表及列表行。
    conversationList: [
      '[data-e2e="message-list"]', '[data-e2e="conversation-list"]', '[data-testid="conversation-list"]',
      '[role="list"][aria-label="会话列表"]', '[data-e2e="im-dialog"] [data-stack-layer="list"]'
    ],
    conversationItem: ['[data-e2e="conversation-item"]'],
    conversationRow: ['[role="listitem"]', '[data-e2e="conversation-item"]', '[data-e2e="conversation-row"]'],
    conversationItemTitle: ['.conversationConversationItemtitle'],
    // 旧式聊天头部里的主页链接。
    legacyHeaderLink: [
      '[data-e2e="chat-header"] a[href]', '[data-e2e="conversation-header"] a[href]', '[class*="chat-header"] a[href]',
      '[class*="chatHeader"] a[href]', '[role="heading"] a[href]'
    ],
    // 输入框；占位/无障碍文案命中 editorExcludeLabel 的是评论框或搜索框。
    editor: ['textarea', '[contenteditable="true"]', '[contenteditable="plaintext-only"]'],
    editorExcludeLabel: ['评论|搜索'],
    // 只包住输入框的容器不是完整输入区（发送箭头在它的兄弟节点），向上越过它。
    editorOnlyContainer: ['.messageEditorimChatEditorContainer'],
    composer: ['.messageMsgInputinputRow', '.messageMsgInputinputColumn'],
    // 富文本输入框（Slate）结构：用于回读已填写的文字。结构不符时退回 innerText。
    richEditor: ['[data-slate-editor="true"]'],
    richEditorLine: ['div.ace-line[data-node="true"]'],
    richEditorLeaf: ['span[data-string="true"][data-leaf="true"]'],
    // 行尾的零宽占位叶子（只在最后一个叶子上识别）。
    richEditorEndSentinel: ['[data-enter="true"]'],
    composerIdentity: ['im[-_ ]?(?:chat|container)|(?:message|chat)[-_ ]?(?:panel|window|container|composer)|conversation|private[-_ ]?message'],
    conversationIdentity: ['im[-_ ]?(?:chat|container)|(?:message|chat)[-_ ]?(?:panel|window|container)|conversation|private[-_ ]?message'],
    // 发送按钮：当前版本是带标识的 SVG 本身；只有观察到的“红色可用”样式才视为可点。
    sendIcon: ['svg.e2e-send-msg-btn'],
    sendIconActive: ['.messageMsgInputpublishBtn.messageMsgInputpublishRedBtn'],
    sendLabel: ['^(?:发送|发送消息|发送私信)$'],
    // 已核验聊天层里的历史气泡结构（只用于“曾发过”的正向证据）。
    messageList: ['.messageMessageListlist'],
    bubble: ['.messageMessageBoxmessageBox'],
    bubbleBox: ['.messageMessageBoxcontentBox'],
    bubbleBoxFromMe: ['.messageMessageBoxisFromMe'],
    bubbleColumn: ['.MessageBoxContentcolumnBox'],
    bubbleColumnFromMe: ['.MessageBoxContentisFromMe'],
    bubbleContent: ['[data-e2e="msg-item-content"]'],
    bubbleText: ['.MessageItemTextcontainer'],
    bubbleTextFromMe: ['.MessageItemTextisFromMe'],
    bubbleSide: ['.MessageBoxContentSidewrapper'],
    bubbleBottom: ['.MessageBoxContentBottomwrapper'],
    bubblePureText: ['.TextMessageTextpureText[data-apm-action="纯文本"]'],
    // 平台系统提示行（拒收 / 限制提示）及要排除的消息正文、输入区。
    noticeCandidates: ['p', 'span', 'div'],
    noticeExclude: ['[data-e2e="msg-item-content"]', '[data-e2e="msg-input"]', '[contenteditable]', 'textarea'],
    noticeText: ['.MessageBoxTipsMessagetext'],
    noticeContent: ['.MessageBoxTipsMessagecontent'],
    noticeLayout: ['.MessageBoxTipsMessagelayout']
  }
};

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * 把“页面函数 (arg, selectors)”包装成只收一个参数的自包含函数：
 * 选择器以 JSON 字面量作为第二个实参内联进函数源码，Playwright 序列化时随之带入页面，
 * 调用方仍按原来的 page.evaluate(fn, arg) 使用。页面函数本身不得闭包引用任何 Node 侧变量。
 */
function bindPageFunction(pageFunction, selectors, name = pageFunction.name) {
  const source = pageFunction.toString();
  // eslint-disable-next-line no-new-func
  const bound = new Function('arg', `return (${source})(arg, ${JSON.stringify(selectors)});`);
  Object.defineProperty(bound, 'name', { value: name });
  return bound;
}

module.exports = { SEARCH: deepFreeze(SEARCH), COMMENTS: deepFreeze(COMMENTS), OUTREACH: deepFreeze(OUTREACH), bindPageFunction };
