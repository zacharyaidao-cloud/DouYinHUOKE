'use strict';

const { identifier } = require('./user-metadata');
const MAX_COMMENT_TIMESTAMP = 253402300799; // Unix seconds, through year 9999 UTC.

// comments[].create_time is seconds. Never infer milliseconds or derive this
// value from a formatted date, fetchTime, or the time of recollection.
function parseCommentTimestamp(value) {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value.trim())) return null;
    value = Number(value.trim());
  }
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value > 0 && value <= MAX_COMMENT_TIMESTAMP ? value : null;
}

function displayTime(seconds) {
  const date = new Date(seconds * 1000);
  const pad = number => String(number).padStart(2, '0');
  // Preserve the existing engine's local display format. Filtering uses the
  // original numeric seconds and is independent of display parsing/timezone.
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function commentId(value) { return identifier(value).trim(); }
function hasTime(lead) { return typeof lead.time === 'string' && Boolean(lead.time.trim()); }

// Return a temporal-evidence patch only. The engine keeps its current dedupe
// key/business history and merges user metadata separately. In particular it
// must not overwrite commentId independently of this patch.
function commentEvidence(comment, previous) {
  if (!comment || typeof comment !== 'object' || Array.isArray(comment)) return {};
  const cid = commentId(comment.cid), timestamp = parseCommentTimestamp(comment.create_time);
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
    return { ...(cid ? { commentId: cid } : {}), time: timestamp === null ? '' : displayTime(timestamp),
      ...(timestamp === null ? {} : { commentTimestamp: timestamp }) };
  }
  const oldCid = commentId(previous.commentId);
  const oldTimestamp = parseCommentTimestamp(previous.commentTimestamp);
  if (oldCid && !cid) return {}; // An unidentified comment cannot retime a known one.
  if (cid && oldCid === cid) {
    const patch = {};
    if (oldTimestamp === null && timestamp !== null) patch.commentTimestamp = timestamp;
    if (!hasTime(previous)) {
      const selected = oldTimestamp === null ? timestamp : oldTimestamp;
      if (selected !== null) patch.time = displayTime(selected);
    }
    return patch; // Same cid: preserve existing time and any valid raw timestamp.
  }
  if (timestamp !== null) {
    // Existing dedupe selects the newly observed cid. Its display and original
    // seconds must move together, including when legacy history has no cid.
    return { ...(cid ? { commentId: cid } : {}), time: displayTime(timestamp), commentTimestamp: timestamp };
  }
  // Do not replace a timed historical comment with a different untimed cid.
  // With no previous temporal evidence, a real cid alone can still be filled.
  if (hasTime(previous) || oldTimestamp !== null) return {};
  return cid ? { commentId: cid } : {};
}

module.exports = { parseCommentTimestamp, commentEvidence };
