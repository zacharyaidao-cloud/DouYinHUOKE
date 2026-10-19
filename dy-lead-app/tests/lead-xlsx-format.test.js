'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const XLSX = require('../lib/xlsx.full.min.js');
const { createLeadWorkbook } = require('../lib/lead-fields');
const { writeLeadXlsx } = require('../lib/lead-xlsx-format');

// An independent ZIP reader checks the OOXML actually delivered to Excel.
// It does not use the serializer's CFB API or any formatter implementation.
function unzip(bytes) {
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) if (bytes.readUInt32LE(end) === 0x06054b50) break;
  assert(end >= 0, 'ZIP end-of-directory record');
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10), size = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42), name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    assert([0, 8].includes(method));
    entries.set(name, method === 8 ? zlib.inflateRawSync(data).toString('utf8') : data.toString('utf8'));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function cellContentDigest(book) {
  const all = [];
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    for (const address of Object.keys(sheet).filter(key => /^[A-Z]+\d+$/.test(key)).sort()) {
      const cell = sheet[address];
      if (cell.v == null && !cell.f) continue;
      all.push([name, address, cell.t, cell.v, cell.f || null, cell.z || null]);
    }
  }
  return crypto.createHash('sha256').update(JSON.stringify(all)).digest('hex');
}

function read(bytes) { return XLSX.read(bytes, { type: 'buffer', cellNF: true }); }
function section(xml, name) { return xml.match(new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>'))[1]; }
function items(xml, singular) { return xml.match(new RegExp('<' + singular + '\\b[^>]*\\/>|<' + singular + '\\b[^>]*>[\\s\\S]*?</' + singular + '>', 'g')) || []; }
function cellStyle(xml, address) { return Number(xml.match(new RegExp('<c\\b[^>]*\\br="' + address + '"[^>]*\\bs="(\\d+)"'))[1]); }
function attribute(xml, name) { return xml.match(new RegExp('\\b' + name + '="([^"]+)"'))[1]; }

test('delivered XLSX has readable real styles, frozen identifiers and only the lead table filter', () => {
  const uid = '7694100713547515455123456789';
  const videos = { '123': { videoLink: 'https://www.douyin.com/note/123', desc: '图文标题\n图文正文 & <text>', likeCount: 0, commentCount: 2 } };
  const book = createLeadWorkbook(XLSX, [{ id: 1, UID: uid, uid, nickname: '测试用户', videoLink: videos['123'].videoLink, demand: '=HYPERLINK("https://example.test","formula")', aiScore: 0 }], videos);
  assert(book.__leadLayout, 'schema supplies export layout');
  const layout = book.__leadLayout;
  // A pre-existing custom number format must survive font/fill decoration.
  const scoreColumn = layout.fields.findIndex(field => field.key === 'aiScore');
  const scoreAddress = XLSX.utils.encode_cell({ r: layout.leadStartRow, c: scoreColumn });
  if (book.Sheets[layout.sheetName][scoreAddress]) book.Sheets[layout.sheetName][scoreAddress].z = '0.00%';
  const original = read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  const bytes = writeLeadXlsx(XLSX, book), result = read(bytes);
  assert.deepEqual(result.SheetNames, ['获客线索']);
  assert.equal(cellContentDigest(result), cellContentDigest(original), 'all delivered nonblank cell values, types and number formats preserved');
  const values = XLSX.utils.sheet_to_json(result.Sheets[layout.sheetName], { header: 1, defval: '' });
  const uidColumn = values[layout.headerRow].indexOf('UID'), demandColumn = values[layout.headerRow].indexOf('需求内容');
  assert.equal(values[layout.leadStartRow][uidColumn], uid);
  const uidAddress = XLSX.utils.encode_cell({ r: layout.leadStartRow, c: uidColumn });
  assert.equal(result.Sheets[layout.sheetName][uidAddress].t, 's');
  assert.equal(values[layout.leadStartRow][demandColumn], '=HYPERLINK("https://example.test","formula")');
  assert.equal(result.Sheets[layout.sheetName][XLSX.utils.encode_cell({ r: layout.leadStartRow, c: demandColumn })].f, undefined);

  const zip = unzip(bytes), styles = zip.get('xl/styles.xml'), sheet = zip.get('xl/worksheets/sheet1.xml');
  assert(styles && sheet);
  const fonts = items(section(styles, 'fonts'), 'font'), fills = items(section(styles, 'fills'), 'fill'), xfs = items(section(styles, 'cellXfs'), 'xf');
  const bodyXf = xfs[cellStyle(sheet, uidAddress)], headerXf = xfs[cellStyle(sheet, 'A4')];
  assert.match(fonts[Number(attribute(bodyXf, 'fontId'))], /<sz val="12"\/>/);
  assert.match(fonts[Number(attribute(bodyXf, 'fontId'))], /Microsoft YaHei/);
  assert.match(fonts[Number(attribute(headerXf, 'fontId'))], /<sz val="14"\/>/);
  assert.match(fonts[Number(attribute(headerXf, 'fontId'))], /rgb="FFFFFFFF"/);
  assert.match(fills[Number(attribute(headerXf, 'fillId'))], /rgb="FF213F60"/);
  assert.match(sheet, /<pane xSplit="4" ySplit="4" topLeftCell="E5" activePane="bottomRight" state="frozen"\/>/);
  assert.match(sheet, /showGridLines="0"/);
  assert(!/<col\b[^>]*\slevel=/.test(sheet), 'OOXML columns omit the JS-only level attribute');
  assert.match(sheet, /<col\b[^>]*outlineLevel="1"/, 'standard outline groups survive');
  const expectedFilter = 'A4:' + XLSX.utils.encode_col(layout.fields.length - 1) + (layout.leadEndRow + 1);
  assert.equal(attribute(sheet.match(/<autoFilter\b[^>]*\/>/)[0], 'ref'), expectedFilter);
  assert.match(sheet, /<row r="5"[^>]*ht="48"[^>]*customHeight="1"/);
  const groupCells = sheet.match(/<row r="3"[^>]*>([\s\S]*?)<\/row>/)[1].match(/<c\b/g) || [];
  assert.equal(groupCells.length, layout.fields.length, 'each group-band column has a real formatted cell');
});

test('long literal texts and full-text JSON remain byte-exact after styling', () => {
  const originalText = ('说明 & <p> _x00a0_ 😀\n').repeat(3000) + '=SUM(1,2)';
  const book = createLeadWorkbook(XLSX, [{ id: 1, uid: '7694100713547515455', demand: originalText, videoLink: 'https://www.douyin.com/note/123' }], { '123': { videoLink: 'https://www.douyin.com/note/123', desc: originalText } });
  const layout = book.__leadLayout;
  assert(layout.fullPartsCount > 0);
  const base = read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  const bytes = writeLeadXlsx(XLSX, book), formatted = read(bytes);
  assert.equal(cellContentDigest(formatted), cellContentDigest(base));
  const rows = XLSX.utils.sheet_to_json(formatted.Sheets[layout.sheetName], { header: 1, defval: '' });
  const fullRows = rows.slice(layout.fullStartRow, layout.fullEndRow + 1);
  const selected = fullRows.filter(row => row[2] === 'demand').sort((a, b) => Number(a[4]) - Number(b[4]));
  assert(selected.length > 1);
  assert.equal(selected.map(row => JSON.parse(row[8])).join(''), originalText);
  assert.equal(crypto.createHash('sha256').update(selected.map(row => JSON.parse(row[8])).join('')).digest('hex'), crypto.createHash('sha256').update(originalText).digest('hex'));
  const xml = unzip(bytes).get('xl/worksheets/sheet1.xml');
  assert(!/<f[\s>]/.test(xml), 'literal user content cannot become Excel formulas');
});

test('empty leads, works without leads and missing text all export a valid single worksheet', () => {
  for (const videos of [{}, { '123': { videoLink: 'https://www.douyin.com/note/123', likeCount: 0 } }]) {
    const book = createLeadWorkbook(XLSX, [], videos), layout = book.__leadLayout;
    const original = read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    const bytes = writeLeadXlsx(XLSX, book), result = read(bytes);
    assert.deepEqual(result.SheetNames, ['获客线索']);
    assert.equal(cellContentDigest(result), cellContentDigest(original));
    assert.equal(layout.leadsCount, 0);
    assert.equal(layout.worksCount, Object.keys(videos).length);
    assert.equal(layout.fullPartsCount, 0);
    const xml = unzip(bytes).get('xl/worksheets/sheet1.xml');
    assert(!/<autoFilter\b/.test(xml), 'empty lead table must not filter the independent work section');
  }
});
