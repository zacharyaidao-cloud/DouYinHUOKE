'use strict';

// SheetJS CE writes values and number formats, but does not write cell fonts or
// fills. Decorate its OOXML package through the bundled public CFB ZIP API.
// Cell contents, types, formulas and number formats remain untouched.
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const COLORS = {
  title: '142D49', header: '213F60', primary: '173D71', basic: '52627A',
  work: '156A72', comment: '775533', user: '61468A', white: 'FFFFFF',
  stripe: 'F2F6FB', text: '162A43', secondary: '40566F', border: 'DEE6F0',
  groupBorder: 'A9BACD'
};

function setAttribute(tag, name, value) {
  const safe = String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const pattern = new RegExp('\\s' + name + '="[^"]*"');
  if (pattern.test(tag)) return tag.replace(pattern, ' ' + name + '="' + safe + '"');
  return tag.replace(/\/?>(?=$)/, end => ' ' + name + '="' + safe + '"' + end);
}

function collection(xml, name) {
  const match = xml.match(new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>'));
  if (!match) throw new Error('Excel 样式缺少 ' + name);
  return match;
}

function appendCollection(xml, name, itemName, contents) {
  const match = collection(xml, name);
  const count = (match[1].match(new RegExp('<' + itemName + '\\b', 'g')) || []).length;
  const opening = setAttribute(match[0].slice(0, match[0].indexOf('>') + 1), 'count', count + contents.length);
  return xml.replace(match[0], opening + match[1] + contents.join('') + '</' + name + '>');
}

function xmlFont(size, color, bold = false) {
  return '<font>' + (bold ? '<b/>' : '') + '<sz val="' + size + '"/><color rgb="FF' + color + '"/>' +
    '<name val="Microsoft YaHei"/><family val="2"/></font>';
}

function xmlFill(color) {
  return '<fill><patternFill patternType="solid"><fgColor rgb="FF' + color + '"/>' +
    '<bgColor indexed="64"/></patternFill></fill>';
}

function xmlBorder(groupStart) {
  return '<border>' + (groupStart ? '<left style="medium"><color rgb="FF' + COLORS.groupBorder + '"/></left>' : '<left/>') +
    '<right/><top/><bottom style="thin"><color rgb="FF' + COLORS.border + '"/></bottom><diagonal/></border>';
}

function decorateStyles(xml) {
  const fontStart = (collection(xml, 'fonts')[1].match(/<font\b/g) || []).length;
  const fillStart = (collection(xml, 'fills')[1].match(/<fill\b/g) || []).length;
  const borderStart = (collection(xml, 'borders')[1].match(/<border\b/g) || []).length;
  const baseStyles = collection(xml, 'cellXfs')[1].match(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g) || [];
  if (!baseStyles.length) throw new Error('Excel 样式没有单元格格式');
  const fills = ['white', 'stripe', 'title', 'header', 'primary', 'basic', 'work', 'comment', 'user'];
  xml = appendCollection(xml, 'fonts', 'font', [
    xmlFont(12, COLORS.text), xmlFont(12, COLORS.secondary), xmlFont(20, COLORS.white, true),
    xmlFont(14, COLORS.white, true), xmlFont(13, COLORS.white, true)
  ]);
  xml = appendCollection(xml, 'fills', 'fill', fills.map(key => xmlFill(COLORS[key])));
  xml = appendCollection(xml, 'borders', 'border', [xmlBorder(false), xmlBorder(true)]);
  const extra = [], cache = new Map();
  function styleId(baseId, kind, groupStart = false) {
    baseId = Number.isInteger(baseId) && baseStyles[baseId] ? baseId : 0;
    const key = baseId + ':' + kind + ':' + Number(groupStart);
    if (cache.has(key)) return cache.get(key);
    let font = 0, fill = kind, alignment = 'vertical="top" wrapText="1"';
    if (kind === 'title') { font = 2; alignment = 'vertical="center"'; }
    else if (kind === 'note') { font = 1; fill = 'white'; alignment = 'vertical="center"'; }
    else if (kind === 'header') { font = 3; alignment = 'vertical="center" wrapText="1"'; }
    else if (['primary', 'basic', 'work', 'comment', 'user'].includes(kind)) {
      font = 4; alignment = 'vertical="center" wrapText="1"';
    }
    let xf = baseStyles[baseId];
    const end = xf.indexOf('>') + 1;
    let opening = xf.slice(0, end);
    const attributes = {
      fontId: fontStart + font, fillId: fillStart + fills.indexOf(fill),
      borderId: borderStart + Number(groupStart), applyFont: 1,
      applyFill: 1, applyBorder: 1, applyAlignment: 1
    };
    for (const [name, value] of Object.entries(attributes)) opening = setAttribute(opening, name, value);
    const children = opening.endsWith('/>') ? '' : xf.slice(end, -5).replace(/<alignment\b[^>]*(?:\/>|>[\s\S]*?<\/alignment>)/g, '');
    xf = opening.replace(/\/>$/, '>') + '<alignment ' + alignment + '/>' + children + '</xf>';
    const id = baseStyles.length + extra.length;
    cache.set(key, id); extra.push(xf); return id;
  }
  return { styleId, finish: () => appendCollection(xml, 'cellXfs', 'xf', extra) };
}

function columnIndex(address) {
  let value = 0;
  for (const letter of address.match(/^[A-Z]+/)[0]) value = value * 26 + letter.charCodeAt(0) - 64;
  return value - 1;
}

function columnName(index) {
  let name = '';
  for (index += 1; index > 0; index = Math.floor((index - 1) / 26)) name = String.fromCharCode(65 + (index - 1) % 26) + name;
  return name;
}

function rowKind(row, layout) {
  if (row === 0 || row === layout.workTitleRow || row === layout.fullTitleRow) return 'title';
  if (row === 1 || row === layout.workTitleRow + 1 || layout.fullTitleRow != null && row === layout.fullTitleRow + 1) return 'note';
  if (row === layout.headerRow || row === layout.workHeaderRow || row === layout.fullHeaderRow) return 'header';
  return row % 2 ? 'stripe' : 'white';
}

function rowHeight(row, layout, sheet) {
  if (row === 0) return 42;
  if (row === 1 || row === layout.workTitleRow + 1 || layout.fullTitleRow != null && row === layout.fullTitleRow + 1) return 30;
  if (row === layout.groupRow) return 32;
  if (row === layout.headerRow || row === layout.workHeaderRow || row === layout.fullHeaderRow) return 42;
  if (row === layout.workTitleRow || row === layout.fullTitleRow) return 36;
  if (layout.fullStartRow != null && row >= layout.fullStartRow && row <= layout.fullEndRow) return 84;
  if (row >= layout.workStartRow && row <= layout.workEndRow || row >= layout.leadStartRow && row <= layout.leadEndRow) {
    let lines = 1;
    const widthCount = row >= layout.workStartRow ? layout.workFields.length : layout.fields.length;
    for (let col = 0; col < widthCount; col++) {
      const value = sheet[columnName(col) + (row + 1)]?.v;
      if (typeof value !== 'string' || !value) continue;
      const width = Math.max(40, (sheet['!cols']?.[col]?.wpx || 160) - 18);
      // Approximate 12 pt glyph widths only to choose a bounded readable row
      // height. Actual text and numeric formatting are never transformed.
      let cellLines = 0;
      for (const paragraph of value.split(/\r?\n/)) {
        let pixels = 0;
        for (const character of paragraph) pixels += character.codePointAt(0) > 255 ? 16 : 8;
        cellLines += Math.max(1, Math.ceil(pixels / width));
        if (cellLines >= 8) break;
      }
      lines = Math.max(lines, Math.min(8, cellLines));
    }
    return Math.max(row >= layout.workStartRow ? 60 : 48, Math.min(144, lines * 18 + 12));
  }
  return 18;
}

function decorateSheet(xml, layout, styles, sheet) {
  const groupColumns = layout.groupColumns || [];
  const groupStarts = new Set(groupColumns.map(group => group.startCol));
  // CE emits the JS-only `level` property as well as OOXML `outlineLevel`.
  // Keep the standard outline grouping and remove the invalid extra attribute.
  xml = xml.replace(/<col\b[^>]*\/>/g, tag => tag.replace(/\slevel="[^"]*"/g, ''));
  function styleCell(tag, row) {
    const address = tag.match(/\br="([A-Z]+\d+)"/);
    if (!address) return tag;
    const col = columnIndex(address[1]);
    let kind = rowKind(row, layout);
    if (row === layout.groupRow) kind = groupColumns.find(group => col >= group.startCol && col <= group.endCol)?.id || 'header';
    if (!Object.hasOwn(COLORS, kind) && kind !== 'note') kind = 'header';
    const baseStyle = Number((tag.match(/\bs="(\d+)"/) || [null, 0])[1]);
    const groupStart = row >= layout.groupRow && row <= layout.leadEndRow && groupStarts.has(col);
    return setAttribute(tag, 's', styles.styleId(baseStyle, kind, groupStart));
  }
  xml = xml.replace(/<row\b[^>]*>[\s\S]*?<\/row>/g, rowXml => {
    const openingEnd = rowXml.indexOf('>') + 1;
    let opening = rowXml.slice(0, openingEnd);
    const row = Number((opening.match(/\br="(\d+)"/) || [null, 1])[1]) - 1;
    opening = setAttribute(setAttribute(opening, 'ht', rowHeight(row, layout, sheet)), 'customHeight', 1);
    let cells = rowXml.slice(openingEnd, -6);
    // Empty group-band cells need real formats too, to display continuous bands.
    if (row === layout.groupRow) {
      const addresses = new Set([...cells.matchAll(/<c\b[^>]*\br="([A-Z]+\d+)"/g)].map(m => m[1]));
      const existing = [...cells.matchAll(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g)].map(m => m[0]);
      for (let col = 0; col < layout.fields.length; col++) {
        const address = columnName(col) + (row + 1);
        if (!addresses.has(address)) existing.push('<c r="' + address + '"/>');
      }
      cells = existing.sort((a, b) => columnIndex(a.match(/\br="([A-Z]+\d+)"/)[1]) - columnIndex(b.match(/\br="([A-Z]+\d+)"/)[1])).join('');
    }
    cells = cells.replace(/<c\b[^>]*>/g, tag => styleCell(tag, row));
    return opening + cells + '</row>';
  });
  const freezeRows = layout.headerRow + 1, freezeColumns = Math.min(4, layout.fields.length);
  const topLeft = columnName(freezeColumns) + (freezeRows + 1);
  const views = '<sheetViews><sheetView showGridLines="0" workbookViewId="0" zoomScale="100">' +
    '<pane xSplit="' + freezeColumns + '" ySplit="' + freezeRows + '" topLeftCell="' + topLeft + '" activePane="bottomRight" state="frozen"/>' +
    '<selection pane="bottomRight" activeCell="' + topLeft + '" sqref="' + topLeft + '"/></sheetView></sheetViews>';
  if (/<sheetViews\b/.test(xml)) xml = xml.replace(/<sheetViews\b[^>]*>[\s\S]*?<\/sheetViews>/, views);
  else xml = xml.replace(/(<dimension\b[^>]*\/>)/, '$1' + views);
  const filter = layout.leadsCount > 0 ? '<autoFilter ref="A' + (layout.headerRow + 1) + ':' + columnName(layout.fields.length - 1) +
    (Math.max(layout.headerRow, layout.leadEndRow) + 1) + '"/>' : '';
  if (/<autoFilter\b/.test(xml)) xml = xml.replace(/<autoFilter\b[^>]*(?:\/>|>[\s\S]*?<\/autoFilter>)/, filter);
  else if (filter) xml = xml.replace('</sheetData>', '</sheetData>' + filter);
  return xml;
}

function writeLeadXlsx(XLSX, book) {
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const layout = book.__leadLayout;
  if (!layout) return bytes;
  if (book.SheetNames.length !== 1 || book.SheetNames[0] !== layout.sheetName || !Array.isArray(layout.fields) || !layout.fields.length) {
    throw new Error('Excel 导出布局与数据不一致');
  }
  const archive = XLSX.CFB.read(bytes, { type: 'buffer' });
  const styleEntry = XLSX.CFB.find(archive, '/xl/styles.xml');
  const sheetEntry = XLSX.CFB.find(archive, '/xl/worksheets/sheet1.xml');
  if (!styleEntry || !sheetEntry) throw new Error('Excel 导出缺少工作表或样式');
  const styles = decorateStyles(Buffer.from(styleEntry.content).toString('utf8'));
  const sheetXml = decorateSheet(Buffer.from(sheetEntry.content).toString('utf8'), layout, styles, book.Sheets[layout.sheetName]);
  for (const [entry, xml] of [[styleEntry, styles.finish()], [sheetEntry, sheetXml]]) {
    entry.content = Buffer.from(xml.startsWith('<?xml') ? xml : XML_DECLARATION + xml, 'utf8');
    entry.size = entry.content.length;
  }
  return Buffer.from(XLSX.CFB.write(archive, { type: 'buffer', fileType: 'zip', compression: true }));
}

module.exports = { writeLeadXlsx };
