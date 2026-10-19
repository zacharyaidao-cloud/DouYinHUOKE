'use strict';

// Public user data only. Both a comment's nested user object and an observed
// profile response can populate these fields without another profile visit.
const USER_FIELDS = {
  nickname: 'nickname', account: 'unique_id', signature: 'signature',
  followerCount: 'follower_count', followingCount: 'following_count',
  favoritedCount: 'total_favorited', awemeCount: 'aweme_count',
  gender: 'gender', province: 'province', city: 'city', school: 'school_name',
  age: 'user_age', commerceLevel: 'commerce_user_level', ipLocation: 'ip_location',
  liveStatus: 'live_status', verificationType: 'verification_type'
};

function identifier(value) {
  return typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
}

function userMetadata(user, { sourcePath = '', capturedAt = '' } = {}) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) return {};
  const path = /^\/aweme\/v1\/web\/(?:comment\/list|user\/profile\/other)\/$/.test(sourcePath) ? sourcePath : '';
  const fields = {}, sources = {};
  const put = (field, value) => {
    if (value === undefined || value === null || !['string', 'number', 'boolean'].includes(typeof value)
      || typeof value === 'number' && !Number.isFinite(value)) return;
    // An empty incidental response must not erase a useful captured value.
    if (typeof value === 'string' && !value.trim()) return;
    fields[field] = value;
    if (path) sources[field] = { path, at: capturedAt };
  };
  for (const [field, key] of Object.entries(USER_FIELDS)) put(field, user[key]);
  const uid = identifier(user.uid);
  if (uid) put('UID', uid);
  const secUid = identifier(user.sec_uid);
  if (secUid) { put('uid', secUid); put('homepage', `https://www.douyin.com/user/${encodeURIComponent(secUid)}`); }
  put('verify', user.enterprise_verify_reason || user.custom_verify);
  if (user.account_cert_info && typeof user.account_cert_info === 'object') put('certInfo', user.account_cert_info.name);
  if (Object.keys(sources).length) fields.userFieldSources = sources;
  if (path && Object.keys(fields).length) { fields.userSourcePath = path; fields.userCapturedAt = capturedAt; }
  return fields;
}

module.exports = { USER_FIELDS, userMetadata, identifier };
